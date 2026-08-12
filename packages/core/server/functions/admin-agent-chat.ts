/**
 * Function name: Admin_Agent_Chat (T9.13)
 * Required method: POST
 * Auth: Netlify Identity (admin allowlist) — the chat runtime's interactive
 *       half. Verbs: create_chat / list_chats / get_chat / send /
 *       approve_tool / deny_tool / cancel.
 *
 * `send` verifies identity, captures the human Principal into the run record
 * SERVER-SIDE, resolves the object's dedicated agent profile (object → type →
 * site default, plan §4a) and the frozen autonomy map (defaults + governance
 * chat_tools + profile overrides), stamps both into the run, and enqueues the
 * background hop with a one-shot trigger token. Approve executes the STORED
 * pending call (or a human-edited, re-validated variant) — client args are
 * never trusted on a plain resume.
 *
 * SECURITY INVARIANT (A§1.2): this identity path never reads or forwards the
 * publish key in any form.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getAdminStateFromEvent, type LambdaContext } from '../lib/admin-auth.js';
import type { ArtifactIndexStore } from '../lib/artifact-index.js';
import { getAgentLearningBlobStore, getArtifactIndexBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import {
  getGovernanceBlobStore,
  getGovernanceDoc,
  putGovernanceDoc,
  resolveActivePolicies,
  type GovernanceBlobStore,
  type GovernanceDoc,
} from '../lib/governance-store.js';
import type { ObjectVerbStore } from '../lib/object-verbs.js';
import { resolveRolesForPrincipalAsync } from '../lib/roles.js';
import { getUsersBlobStore, getUserRecord } from '../lib/users-store.js';
import { buildToolContext } from '../lib/agent/context.js';
import { CmsAgentClient, isCmsAgentConfigured } from '../lib/agent/cms-agent-client.js';
import { humanCopyForCmsAgentError, resolveEffectiveChatMode } from '../lib/agent/engine.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import {
  approvePendingTool,
  cancelRun,
  choosePendingCandidate,
  denyPendingTool,
  rejectPendingCandidates,
  startRun,
} from '../lib/agent/loop.js';
import {
  getAgentChatBlobStore,
  listChatDocs,
  loadChatDoc,
  mintFreeChatId,
  objectChatId,
  saveChatDoc,
  type ChatDoc,
  type RegistryKind,
} from '../lib/agent/chat-store.js';
import { visibleChatDocs } from '../lib/agent/chat-visibility.js';
import {
  agentProviderSchema,
  getAgentProfilesBlobStore,
  getProfilesDoc,
  putProfilesDoc,
  resolveProfile,
  type AgentProfile,
  type AgentProfilesDoc,
  type AgentProfilesStore,
} from '../lib/agent/profiles.js';
import { isOwner } from '../lib/roles.js';
import { randomUUID } from 'node:crypto';
import { resolveAutonomy, type ToolAutonomy } from '../lib/agent/tools.js';
import { migrateAutonomyKeys, resolveGeneratedAutonomy } from '../lib/agent/generated-tools.js';
import { candidateSetView } from '../lib/agent/candidates.js';
import { exportPreferencePairs, type LearningEvidenceStore } from '../lib/agent/preferences.js';
import { objectTypeSchema, type Principal } from '../../schema/object-record-v1.js';
import { z } from 'zod';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  statusCode: status,
  headers: jsonHeaders,
  body: JSON.stringify({ ok: status >= 200 && status < 300, status, ...body }),
});

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create_chat'),
    kind: z.enum(['object', 'free']),
    object_type: objectTypeSchema.optional(),
    object_id: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
  }),
  z.object({ action: z.literal('list_chats'), include_all: z.boolean().optional() }),
  z.object({
    action: z.literal('get_chat'),
    chat_id: z.string().min(1),
    since_seq: z.number().int().nonnegative().optional(),
  }),
  z.object({
    action: z.literal('send'),
    chat_id: z.string().min(1),
    text: z.string().min(1).max(20_000),
    focus: z.string().min(1).max(500).optional(),
  }),
  z.object({
    action: z.literal('approve_tool'),
    chat_id: z.string().min(1),
    call_id: z.string().min(1),
    /** Edit-and-approve: HUMAN-edited args, re-validated against the tool schema. */
    edited_args: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    action: z.literal('deny_tool'),
    chat_id: z.string().min(1),
    call_id: z.string().min(1),
    reason: z.string().max(2000).optional(),
  }),
  z.object({ action: z.literal('cancel'), chat_id: z.string().min(1) }),
  z.object({
    action: z.literal('choose_candidate'),
    chat_id: z.string().min(1),
    call_id: z.string().min(1),
    candidate_id: z.string().min(1),
  }),
  z.object({
    action: z.literal('reject_candidates'),
    chat_id: z.string().min(1),
    call_id: z.string().min(1),
    reason: z.string().min(1).max(2000),
  }),
  z.object({ action: z.literal('export_preferences') }),
  // ─── T9.26: roster & assignment (read: Admin; manage/assign: Owner) ────────
  z.object({ action: z.literal('list_profiles') }),
  z.object({
    action: z.literal('upsert_profile'),
    profile: z.object({
      profile_id: z.string().min(1).optional(),
      name: z.string().min(1).max(120),
      avatar_artifact: z.string().optional(),
      provider: agentProviderSchema,
      model: z.string().min(1).max(120),
      system_prompt: z.string().max(20_000).optional(),
      tool_autonomy_overrides: z.record(z.string(), z.enum(['auto', 'ask', 'off'])).optional(),
      status: z.enum(['active', 'disabled']).optional(),
    }),
  }),
  z.object({
    action: z.literal('assign_profile'),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('object'), object_id: z.string().min(1) }),
      z.object({ kind: z.literal('type'), object_type: objectTypeSchema }),
      z.object({ kind: z.literal('site_default') }),
    ]),
    /** null clears the assignment (falls back down the §4a chain). */
    profile_id: z.union([z.string().min(1), z.null()]),
  }),
]);

/** PF4: one client per process; the tool bridge is undefined when unconfigured. */
const cmsAgentClient = new CmsAgentClient();
const cmsAgentToolBridge = () =>
  isCmsAgentConfigured()
    ? {
        callTool: <T,>(name: string, args: Record<string, unknown>) => cmsAgentClient.callTool<T>(name, args),
        projectId: getSiteIdentity().cmsAgentProjectId,
      }
    : undefined;

/** Fire-and-forget background trigger; a lost POST leaves the doc queued and
 *  recoverable via the stale-takeover path (send/cancel after STALE_RUN_MS). */
const triggerBackground = async (chatId: string, triggerToken: string): Promise<void> => {
  const base = process.env.URL;
  if (!base) return;
  try {
    await fetch(`${base}/.netlify/functions/admin-agent-chat-run-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, trigger_token: triggerToken }),
    });
  } catch (error) {
    console.error('agent chat background trigger failed', { chatId, error });
  }
};

const agentView = (p: Pick<AgentProfile, 'profile_id' | 'name' | 'provider' | 'model' | 'avatar_artifact'>) => ({
  profile_id: p.profile_id,
  name: p.name,
  provider: p.provider,
  model: p.model,
  ...(p.avatar_artifact ? { avatar_artifact: p.avatar_artifact } : {}),
});

/** `idleProfile` is the §4a-resolved agent to name when NO run exists yet — so
 *  the chip shows the real agent (name + provider) before the first message,
 *  not the generic fallback (T9.16 idle-chip finding). A run (live or last)
 *  always wins, since its frozen profile is the agent that actually ran. */
const chatSummary = (doc: ChatDoc, idleProfile?: AgentProfile) => ({
  chat_id: doc.chat_id,
  kind: doc.kind,
  ...(doc.object_type ? { object_type: doc.object_type } : {}),
  ...(doc.object_id ? { object_id: doc.object_id } : {}),
  title: doc.title,
  status: doc.status,
  updated_at: doc.updated_at,
  last_outcome: doc.runs[doc.runs.length - 1] ?? null,
  ...(doc.run ? { agent: agentView(doc.run.profile) } : idleProfile ? { agent: agentView(idleProfile) } : {}),
});

/** Resolve the agent to display for an idle (never-run) chat; a chat that has
 *  a run carries its own frozen agent, so none is needed. */
const idleProfileFor = (profilesDoc: AgentProfilesDoc, doc: ChatDoc): AgentProfile | undefined =>
  doc.run ? undefined : resolveProfile(profilesDoc, { objectId: doc.object_id, objectType: doc.object_type });

/**
 * Task 3 §6 — canonicalize governance `chat_tools` through `migrateAutonomyKeys`
 * ONCE (the `chat_tools_migrated` stamp short-circuits repeat work), best-
 * effort persisting the migrated doc back. A failure to persist is non-fatal:
 * the in-memory migrated map is still returned for this run.
 */
const migratedChatTools = async (
  store: GovernanceBlobStore,
  doc: GovernanceDoc | null
): Promise<Record<string, ToolAutonomy> | undefined> => {
  if (!doc || doc.chat_tools_migrated) return doc?.chat_tools as Record<string, ToolAutonomy> | undefined;
  const migrated = migrateAutonomyKeys(doc.chat_tools as Record<string, ToolAutonomy> | undefined);
  if (!migrated.changed) return doc.chat_tools as Record<string, ToolAutonomy> | undefined;
  const next: GovernanceDoc = { ...doc, chat_tools: migrated.map, chat_tools_migrated: true };
  await putGovernanceDoc(store, next).catch((error) => {
    console.error('governance chat_tools key migration write-back failed', error);
  });
  return migrated.map;
};

/**
 * Task 3 §6 — canonicalize every profile's `tool_autonomy_overrides` through
 * `migrateAutonomyKeys` ONCE (the doc-level `keys_migrated` stamp short-
 * circuits repeat work), best-effort persisting the migrated doc back. A
 * failure to persist is non-fatal: the in-memory migrated doc is still used.
 */
const migratedProfilesDoc = async (
  store: AgentProfilesStore,
  doc: AgentProfilesDoc
): Promise<AgentProfilesDoc> => {
  if (doc.keys_migrated) return doc;
  let changed = false;
  const profiles: AgentProfilesDoc['profiles'] = {};
  for (const [profileId, profile] of Object.entries(doc.profiles)) {
    const migrated = migrateAutonomyKeys(profile.tool_autonomy_overrides);
    if (migrated.changed) {
      changed = true;
      profiles[profileId] = { ...profile, tool_autonomy_overrides: migrated.map };
    } else {
      profiles[profileId] = profile;
    }
  }
  if (!changed) return doc;
  const next: AgentProfilesDoc = { ...doc, profiles, keys_migrated: true };
  await putProfilesDoc(store, next).catch((error) => {
    console.error('agent-profiles chat-tool key migration write-back failed', error);
  });
  return next;
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  const adminState = await getAdminStateFromEvent(event, context);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });

  // T9.4 house pattern: the wall is the RESOLVED role set (users store +
  // ADMIN_EMAILS bootstrap owners) — invited store-tier admins get in; a
  // disabled member loses access.
  const callerPrincipal: Principal = {
    kind: 'human',
    id: adminState.userId ?? '',
    email: adminState.email ?? '',
  };
  const callerRoles = await resolveRolesForPrincipalAsync(callerPrincipal, {
    getUserRecord: async (email) => getUserRecord(await getUsersBlobStore(event), email),
  });
  if (!callerRoles.includes('admin')) return jsonResponse(403, { error: 'Admin access required' });

  let parsedBody: unknown;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    parsedBody = JSON.parse(raw);
  } catch {
    return jsonResponse(400, { error: 'Invalid request body.' });
  }
  const request = requestSchema.safeParse(parsedBody);
  if (!request.success) return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });

  const caller = { id: adminState.userId ?? '', email: adminState.email ?? '' };
  const nowIso = () => new Date().toISOString();

  try {
    const chatStore = await getAgentChatBlobStore(event);

    switch (request.data.action) {
      case 'create_chat': {
        const profilesDoc = await getProfilesDoc(await getAgentProfilesBlobStore(event), nowIso());
        if (request.data.kind === 'object') {
          if (!request.data.object_type || !request.data.object_id) {
            return jsonResponse(400, { error: 'object chats need object_type and object_id.' });
          }
          const chatId = objectChatId(request.data.object_id);
          const existing = await loadChatDoc(chatStore, chatId);
          if (existing)
            return jsonResponse(200, {
              chat: chatSummary(existing, idleProfileFor(profilesDoc, existing)),
              existed: true,
            });
          const doc: ChatDoc = {
            schema_version: 'agent-chat.v1',
            chat_id: chatId,
            kind: 'object',
            object_type: request.data.object_type,
            object_id: request.data.object_id,
            title: request.data.title ?? request.data.object_id,
            created_by: caller.email,
            created_at: nowIso(),
            updated_at: nowIso(),
            status: 'idle',
            seq: 0,
            events: [],
            runs: [],
          };
          await saveChatDoc(chatStore, doc);
          return jsonResponse(200, { chat: chatSummary(doc, idleProfileFor(profilesDoc, doc)), existed: false });
        }
        const doc: ChatDoc = {
          schema_version: 'agent-chat.v1',
          chat_id: mintFreeChatId(),
          kind: 'free',
          title: request.data.title ?? 'New conversation',
          created_by: caller.email,
          created_at: nowIso(),
          updated_at: nowIso(),
          status: 'idle',
          seq: 0,
          events: [],
          runs: [],
        };
        await saveChatDoc(chatStore, doc);
        return jsonResponse(200, { chat: chatSummary(doc, idleProfileFor(profilesDoc, doc)), existed: false });
      }

      case 'list_chats': {
        if (request.data.include_all && !isOwner(callerRoles)) {
          return jsonResponse(403, { error: 'Owner access required to list other administrators’ chats.' });
        }
        const docs = await listChatDocs(chatStore);
        const visibleDocs = visibleChatDocs(
          docs,
          caller.email,
          Boolean(request.data.include_all),
          isOwner(callerRoles)
        );
        const profilesDoc = await getProfilesDoc(await getAgentProfilesBlobStore(event), nowIso());
        return jsonResponse(200, {
          chats: visibleDocs.map((doc) => chatSummary(doc, idleProfileFor(profilesDoc, doc))),
        });
      }

      case 'get_chat': {
        const doc = await loadChatDoc(chatStore, request.data.chat_id);
        if (!doc) return jsonResponse(404, { error: 'chat not found' });
        const since = request.data.since_seq ?? 0;
        const profilesDoc = doc.run
          ? undefined
          : await getProfilesDoc(await getAgentProfilesBlobStore(event), nowIso());
        return jsonResponse(200, {
          ...chatSummary(doc, profilesDoc ? idleProfileFor(profilesDoc, doc) : undefined),
          seq: doc.seq,
          events: doc.events.filter((eventItem) => eventItem.seq > since),
          ...(doc.status === 'awaiting_approval' && doc.run?.pending
            ? {
                pending: {
                  call_id: doc.run.pending.call_id,
                  tool: doc.run.pending.tool,
                  args: doc.run.pending.args,
                  ...(doc.run.pending.dry_run ? { dry_run: doc.run.pending.dry_run } : {}),
                },
              }
            : {}),
          ...(doc.status === 'awaiting_candidate' && doc.run?.candidate_selection
            ? { candidate_set: candidateSetView(doc.run.candidate_selection) }
            : {}),
        });
      }

      case 'send': {
        const doc = await loadChatDoc(chatStore, request.data.chat_id);
        if (!doc) return jsonResponse(404, { error: 'chat not found — create_chat first.' });

        const governanceStore = await getGovernanceBlobStore(event);
        const policies = await resolveActivePolicies(governanceStore);
        const { learning_mode } = policies;
        // Task 3 §1: the rollback lever — unset resolves to 'generated'.
        const registryKind: RegistryKind = policies.chat_registry ?? 'generated';

        // PF3: in required mode a missing bridge config fails AT SEND with a
        // clear error instead of queueing a run that can only die in the hop.
        const { mode: chatEngineMode } = resolveEffectiveChatMode(policies.cms_agent_chat_mode);
        if (chatEngineMode === 'required' && !isCmsAgentConfigured()) {
          return jsonResponse(503, {
            error: humanCopyForCmsAgentError('cms_agent_not_configured'),
            code: 'cms_agent_not_configured',
          });
        }

        // Task 3 §6: canonicalize stored autonomy keys ON READ (best-effort
        // write-back; the in-memory migrated values are used for this run
        // regardless of whether the persist succeeds).
        const rawGovernanceDoc = await getGovernanceDoc(governanceStore);
        const chatTools = await migratedChatTools(governanceStore, rawGovernanceDoc);
        const profilesStore = await getAgentProfilesBlobStore(event);
        const profilesDoc = await migratedProfilesDoc(profilesStore, await getProfilesDoc(profilesStore, nowIso()));

        // §4a: resolve the dedicated agent AT SEND TIME and stamp it into the run.
        const profile = resolveProfile(profilesDoc, {
          objectId: doc.object_id,
          objectType: doc.object_type,
        });

        const autonomy =
          registryKind === 'legacy'
            ? resolveAutonomy(chatTools, profile.tool_autonomy_overrides)
            : resolveGeneratedAutonomy(chatTools, profile.tool_autonomy_overrides);

        // Title generation: a fresh default-titled chat adopts its first message.
        if (doc.runs.length === 0 && (doc.title === 'New conversation' || doc.title === doc.object_id)) {
          const line = request.data.text.split('\n')[0] ?? '';
          if (doc.kind === 'free') doc.title = line.length > 80 ? `${line.slice(0, 77)}…` : line;
        }

        const principal: Principal = { kind: 'human', ...caller };
        const objectStore = (await getSiteObjectsBlobStore(event)) as unknown as ObjectVerbStore;
        const roles = await resolveRolesForPrincipalAsync(principal, {
          getUserRecord: async (email) => getUserRecord(await getUsersBlobStore(event), email),
        });
        const cmsAgent = cmsAgentToolBridge();
        const toolContext = buildToolContext({
          objectStore,
          ...(cmsAgent ? { cmsAgent } : {}),
          governanceStore,
          artifactIndexStore: (await getArtifactIndexBlobStore(event).catch(() => undefined)) as unknown as
            | ArtifactIndexStore
            | undefined,
          principal,
          roles,
          exportRoot: binding.dataRoot,
        });
        const result = await startRun(
          { chatStore, toolContext },
          doc,
          request.data.text,
          caller,
          {
            profile_id: profile.profile_id,
            name: profile.name,
            provider: profile.provider,
            model: profile.model,
            ...(profile.avatar_artifact ? { avatar_artifact: profile.avatar_artifact } : {}),
            system_prompt: profile.system_prompt,
          },
          autonomy,
          learning_mode,
          request.data.focus,
          roles.includes('owner'),
          registryKind
        );
        if (result.resume) await triggerBackground(request.data.chat_id, result.resume.triggerToken);
        return jsonResponse(result.status, result.body);
      }

      case 'approve_tool':
      case 'deny_tool':
      case 'choose_candidate':
      case 'reject_candidates': {
        const doc = await loadChatDoc(chatStore, request.data.chat_id);
        if (!doc?.run) return jsonResponse(404, { error: 'chat not found' });
        // Execution happens NOW, under the RUN's principal (the human who owns
        // the run) — the approver is recorded on the event. Roles are
        // re-resolved fresh so a demotion takes effect on the next write.
        const runPrincipal: Principal = doc.run.principal;
        const objectStore = (await getSiteObjectsBlobStore(event)) as unknown as ObjectVerbStore;
        const roles = await resolveRolesForPrincipalAsync(runPrincipal, {
          getUserRecord: async (email) => getUserRecord(await getUsersBlobStore(event), email),
        });
        const cmsAgent = cmsAgentToolBridge();
        const toolContext = buildToolContext({
          objectStore,
          ...(cmsAgent ? { cmsAgent } : {}),
          governanceStore: await getGovernanceBlobStore(event),
          artifactIndexStore: (await getArtifactIndexBlobStore(event).catch(() => undefined)) as unknown as
            | ArtifactIndexStore
            | undefined,
          principal: runPrincipal,
          roles,
          exportRoot: binding.dataRoot,
          // Task 3 §5: so an approved/executed generated-registry tool that
          // rides the operational bridge (deploy_status, pdf-tool/image
          // families, commerce, ...) can execute on THIS interactive path too,
          // not only inside the background hop.
          operationalEvent: event,
        });
        const protocolDeps = {
          chatStore,
          toolContext,
          learningStore: (await getAgentLearningBlobStore(event)) as unknown as LearningEvidenceStore,
          siteId: binding.siteId,
        };
        const result =
          request.data.action === 'approve_tool'
            ? await approvePendingTool(
                protocolDeps,
                request.data.chat_id,
                request.data.call_id,
                caller,
                request.data.edited_args
              )
            : request.data.action === 'deny_tool'
              ? await denyPendingTool(
                  protocolDeps,
                  request.data.chat_id,
                  request.data.call_id,
                  caller,
                  request.data.reason
                )
              : request.data.action === 'choose_candidate'
                ? await choosePendingCandidate(
                    protocolDeps,
                    request.data.chat_id,
                    request.data.call_id,
                    request.data.candidate_id,
                    caller
                  )
                : await rejectPendingCandidates(
                    protocolDeps,
                    request.data.chat_id,
                    request.data.call_id,
                    request.data.reason,
                    caller
                  );
        if (result.resume) await triggerBackground(request.data.chat_id, result.resume.triggerToken);
        return jsonResponse(result.status, result.body);
      }

      case 'cancel': {
        const objectStore = (await getSiteObjectsBlobStore(event)) as unknown as ObjectVerbStore;
        const toolContext = buildToolContext({
          objectStore,
          principal: { kind: 'human', ...caller },
          roles: [],
        });
        const result = await cancelRun({ chatStore, toolContext }, request.data.chat_id);
        return jsonResponse(result.status, result.body);
      }

      case 'export_preferences': {
        if (!isOwner(callerRoles)) return jsonResponse(403, { error: 'Owner access required' });
        const exported = await exportPreferencePairs(
          (await getAgentLearningBlobStore(event)) as unknown as LearningEvidenceStore
        );
        return jsonResponse(200, { ...exported });
      }

      case 'list_profiles': {
        const doc = await getProfilesDoc(await getAgentProfilesBlobStore(event), nowIso());
        return jsonResponse(200, { profiles: Object.values(doc.profiles), assignments: doc.assignments });
      }

      case 'upsert_profile':
      case 'assign_profile': {
        // Owner-only management (§4a); reads stay open to any admin.
        if (!isOwner(callerRoles)) return jsonResponse(403, { error: 'Managing agents requires the Owner role.' });

        const profilesStore = await getAgentProfilesBlobStore(event);
        const doc = await getProfilesDoc(profilesStore, nowIso());

        if (request.data.action === 'upsert_profile') {
          const input = request.data.profile;
          const profileId = input.profile_id ?? `prof_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
          const existing = doc.profiles[profileId];
          const profile = {
            profile_id: profileId,
            name: input.name,
            ...(input.avatar_artifact ? { avatar_artifact: input.avatar_artifact } : {}),
            provider: input.provider,
            model: input.model,
            system_prompt: input.system_prompt ?? existing?.system_prompt ?? '',
            ...(input.tool_autonomy_overrides ? { tool_autonomy_overrides: input.tool_autonomy_overrides } : {}),
            status: input.status ?? existing?.status ?? ('active' as const),
            created_by: existing?.created_by ?? caller.email,
            updated_at: nowIso(),
          };
          doc.profiles[profileId] = profile;
          doc.updated_at = nowIso();
          await putProfilesDoc(profilesStore, doc);
          return jsonResponse(200, { profile });
        }

        const { target, profile_id: profileId } = request.data;
        if (profileId !== null && !doc.profiles[profileId]) {
          return jsonResponse(404, { error: `No profile "${profileId}".` });
        }
        if (target.kind === 'object') {
          if (profileId === null) delete doc.assignments.objects[target.object_id];
          else doc.assignments.objects[target.object_id] = profileId;
        } else if (target.kind === 'type') {
          if (profileId === null) delete doc.assignments.types[target.object_type];
          else doc.assignments.types[target.object_type] = profileId;
        } else {
          if (profileId === null) delete doc.assignments.site_default;
          else doc.assignments.site_default = profileId;
        }
        doc.updated_at = nowIso();
        await putProfilesDoc(profilesStore, doc);
        return jsonResponse(200, { assignments: doc.assignments });
      }
    }
  } catch (error) {
    console.error('Admin_Agent_Chat request failed.', error);
    return jsonResponse(500, { error: 'Agent chat request could not be processed.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. T11.6: threads dataRoot to the publish path. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
