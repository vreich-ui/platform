/**
 * Function name: Admin_Agent_Chat_Run (T9.13) — Netlify BACKGROUND function
 * (`-background` suffix: 202 to the caller, 15-minute budget).
 *
 * One hop of the agent loop. Authorization is the one-shot trigger token
 * minted into the chat doc by send/approve/deny — consumed on start, so
 * replays and forged POSTs are inert (T9.12 mechanic). The provider adapter
 * comes from the RUN's stamped profile (provider/model never hardcoded);
 * writes execute under the run's HUMAN principal with freshly-resolved roles.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getHeader } from '../lib/admin-auth.js';
import type { ArtifactIndexStore } from '../lib/artifact-index.js';
import { getAgentLearningBlobStore, getArtifactIndexBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { getGovernanceBlobStore, getGovernanceDoc } from '../lib/governance-store.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import type { ObjectVerbStore } from '../lib/object-verbs.js';
import { resolveRolesForPrincipalAsync } from '../lib/roles.js';
import { getUsersBlobStore, getUserRecord } from '../lib/users-store.js';
import { getAgentChatBlobStore, loadChatDoc } from '../lib/agent/chat-store.js';
import { buildToolContext } from '../lib/agent/context.js';
import { CmsAgentClient, isCmsAgentConfigured } from '../lib/agent/cms-agent-client.js';
import { buildChatEngine, resolveEffectiveChatMode } from '../lib/agent/engine.js';
import { runAgentLoop } from '../lib/agent/loop.js';
import type { LearningEvidenceStore } from '../lib/agent/preferences.js';
import { adapterForProfile } from '../lib/agent/provider.js';
import { z } from 'zod';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};
type LambdaContext = { getRemainingTimeInMillis?: () => number };

/** One client per site process (PF1's design): module-level so the MCP session
 *  and the agent_ref cache survive warm invocations. Construction is
 *  side-effect-free; config is read at call time, never at import time. */
const cmsAgentClient = new CmsAgentClient();

const bodySchema = z.object({ chat_id: z.string().min(1), trigger_token: z.string().min(1) });

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!getHeader(event.headers, 'content-type').includes('application/json')) {
    return { statusCode: 415, body: 'application/json required' };
  }
  let parsed: z.infer<typeof bodySchema>;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    parsed = bodySchema.parse(JSON.parse(raw));
  } catch {
    return { statusCode: 400, body: 'Invalid body' };
  }

  const chatStore = await getAgentChatBlobStore(event);
  const doc = await loadChatDoc(chatStore, parsed.chat_id);
  if (!doc?.run) return { statusCode: 404, body: 'chat not found' };

  const principal = doc.run.principal;
  const roles = await resolveRolesForPrincipalAsync(principal, {
    getUserRecord: async (email) => getUserRecord(await getUsersBlobStore(event), email),
  });
  const governanceStore = await getGovernanceBlobStore(event);
  // PF4: the workspace orchestration tools reach CMS-Agent through the same
  // module-level client; absent config → the tools answer with a clear error.
  const cmsAgentBridge = isCmsAgentConfigured()
    ? {
        callTool: <T,>(name: string, args: Record<string, unknown>) => cmsAgentClient.callTool<T>(name, args),
        projectId: getSiteIdentity().cmsAgentProjectId,
      }
    : undefined;
  // Task 5 fix 1: cap operational tools' inline waits to what's actually left
  // on THIS invocation (mirrors mcp.ts's handler) — approve now defers
  // EXECUTION to this hop, so a long inline wait (e.g.
  // create_agent_artifact_job) must be bounded here, not just at send/approve.
  const remainingTimeMs =
    typeof context?.getRemainingTimeInMillis === 'function' ? context.getRemainingTimeInMillis() : undefined;
  const eventWithDeadline = {
    ...event,
    ...(remainingTimeMs !== undefined ? { invocationDeadlineMs: Date.now() + remainingTimeMs } : {}),
  };
  const toolContext = buildToolContext({
    objectStore: (await getSiteObjectsBlobStore(event)) as unknown as ObjectVerbStore,
    governanceStore,
    ...(cmsAgentBridge ? { cmsAgent: cmsAgentBridge } : {}),
    artifactIndexStore: (await getArtifactIndexBlobStore(event).catch(() => undefined)) as unknown as
      | ArtifactIndexStore
      | undefined,
    principal,
    roles,
    exportRoot: binding.dataRoot,
    // Task 3 §5: so the generated registry's operational-bridge tools
    // (deploy_status, pdf-tool/image families, commerce, ...) execute in the
    // background hop too, not only on the interactive approve path.
    operationalEvent: eventWithDeadline,
  });

  // PF2/PF3 — TurnEngine selection: governance override ?? CMS_AGENT_CHAT_MODE ?? 'off'.
  // 'off' is the byte-identical legacy path; 'required' is CMS-Agent-only
  // fail-fast; 'fallback' degrades to the provider path with a loud
  // engine_fallback event (buildChatEngine). Resolved PER HOP deliberately:
  // the PF5 rollback lever (override → 'off') must take effect instantly,
  // including for a run paused behind an approval card — safe because the
  // transcript is provider-neutral, so either engine can continue any run.
  // A failed governance read degrades to the env default, the same
  // never-brick doctrine as resolveActivePolicies.
  const governanceDoc = await getGovernanceDoc(governanceStore).catch(() => null);
  const { mode } = resolveEffectiveChatMode(governanceDoc?.cms_agent_chat_mode);
  const engine = buildChatEngine({
    mode,
    adapter: adapterForProfile(doc.run.profile),
    client: cmsAgentClient,
    projectId: getSiteIdentity().cmsAgentProjectId,
    siteId: binding.siteId,
  });

  const result = await runAgentLoop(
    {
      chatStore,
      toolContext,
      engine,
      // Task 5: an edit-and-approve's EXECUTION now happens in this hop, not
      // inline in approve — addPostEditDelta needs the learning store here.
      learningStore: (await getAgentLearningBlobStore(event)) as unknown as LearningEvidenceStore,
      ...(context?.getRemainingTimeInMillis ? { remainingMs: () => context.getRemainingTimeInMillis!() } : {}),
    },
    parsed.chat_id,
    parsed.trigger_token
  );
  console.info('agent chat hop finished', { chat_id: parsed.chat_id, ...result });
  return { statusCode: result.ok ? 200 : 409, body: JSON.stringify(result) };
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. T11.6: threads dataRoot to the publish path. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
