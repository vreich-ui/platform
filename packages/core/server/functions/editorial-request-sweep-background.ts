/**
 * Function name: Editorial_Request_Sweep_Run (W19 T19.3) — Netlify BACKGROUND
 * function (`-background` suffix: 202 to the caller, 15-minute budget).
 *
 * The worker the scheduled sweep hands its candidate list to. It is the ONLY
 * writer of a running request's status (plan §5.3 rule 1): it reads each run
 * from CMS-Agent, derives the editor-facing status through the pure core, and
 * writes through the T19.1 writers.
 *
 * AUTHORIZATION is the one-shot trigger token the scheduled tick mints into
 * the store, consumed on start — the T9.12 mechanic the chat loop uses. A
 * background function is a PUBLIC HTTP endpoint and this one's side effects
 * are real (up to 200 CMS-Agent reads plus `workflow_run_all` nudges, i.e.
 * model spend), so "a replayed sweep is inert" is true of the RECORD and not
 * of the bill. The token also means two passes can never overlap, which is
 * what makes the nudge cap a cap.
 */
import { z } from 'zod';

import type { SiteBinding } from '../lib/site-binding.js';
import { getHeader } from '../lib/admin-auth.js';
import { getAgentChatBlobStore, appendChatEvent, loadChatDoc, saveChatDoc } from '../lib/agent/chat-store.js';
import { getEditorialRequestsBlobStore } from '../lib/blob-store.js';
import { CmsAgentClient, isCmsAgentConfigured } from '../lib/agent/cms-agent-client.js';
import { consumeSweepToken } from '../lib/requests/store.js';
import {
  runSweep,
  sweepRequest,
  type SweepBridge,
  type SweepChatSink,
  type SweepMailer,
} from '../lib/requests/sweep.js';
import { resolveMailSender, requestMail } from '../lib/mail/send.js';
import { isMailConfigured } from '../lib/mail/index.js';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};
type LambdaContext = { getRemainingTimeInMillis?: () => number };

/** One client per site process (the PF1 design): the MCP session survives warm invocations. */
const cmsAgentClient = new CmsAgentClient();

const bodySchema = z.object({
  /** The one-shot token the scheduled tick minted — consumed on start (see store.ts). */
  trigger_token: z.string().min(1),
  request_ids: z.array(z.string().min(1)).max(200).optional(),
});

const bridge = (): SweepBridge | undefined =>
  isCmsAgentConfigured()
    ? {
        // `workflow_get_run` answers `ok({ run, mode, stall })`; the client unwraps
        // only the `{ok,data}` envelope, so the row must be lifted out here. It is
        // NOT cosmetic: handing derive-status the envelope meant `runId`, `status`
        // and `nodes` were all undefined, so a request with a live run derived a
        // shape-unreadable `running` for ever and could never reach done/failed.
        // `stall` is a SIBLING of `run` on the wire but derive-status reads it off
        // the snapshot (§5.2's dispatch heartbeat), so it is folded back in.
        getRun: async (runId) => {
          const result = await cmsAgentClient.callTool<Record<string, unknown>>('workflow_get_run', { runId });
          if (!result.ok) return result;
          const payload = result.data;
          const row =
            typeof payload.run === 'object' && payload.run !== null && !Array.isArray(payload.run)
              ? (payload.run as Record<string, unknown>)
              : payload;
          return { ok: true, data: { ...row, ...(payload.stall !== undefined ? { stall: payload.stall } : {}) } };
        },
        advance: (runId, budgetMs) =>
          cmsAgentClient.callTool<Record<string, unknown>>('workflow_run_all', { runId, budgetMs }),
        // C1: `node_get_latest_output`, for the publish/release receipts the
        // compact run view does not carry — see `publication-outputs.ts` for
        // why those two reads beat a `detail: "full"` run record.
        callTool: (name, args) => cmsAgentClient.callTool(name, args),
      }
    : undefined;

/**
 * T19.7: mail, only where a provider is actually configured. An unconfigured
 * tenant gets NO mailer at all rather than a null one that logs a refusal on
 * every transition — unconfigured is the normal state, not an incident.
 */
const mailer = (): SweepMailer | undefined => {
  if (!isMailConfigured()) return undefined;
  const sender = resolveMailSender();
  return {
    notify: async (input) => {
      const { subject, text } = requestMail({
        requestId: input.requestId,
        title: input.title,
        status: input.status,
        ...(input.statusReason ? { statusReason: input.statusReason } : {}),
        ...(process.env.URL ? { origin: process.env.URL } : {}),
      });
      const result = await sender.send({
        to: input.to,
        subject,
        text,
        tags: { kind: 'editorial_request', status: input.status },
      });
      return result.ok ? { ok: true } : { ok: false, code: result.code };
    },
  };
};

const chatSink = async (event: unknown): Promise<SweepChatSink> => {
  const chatStore = await getAgentChatBlobStore(event);
  return {
    appendProgress: async (chatId, detail) => {
      const doc = await loadChatDoc(chatStore, chatId);
      if (!doc) return;
      appendChatEvent(doc, new Date().toISOString(), 'request_progress', detail);
      await saveChatDoc(chatStore, doc);
    },
    chatStatus: async (chatId) => (await loadChatDoc(chatStore, chatId))?.status,
  };
};

const buildHandlerImpl = (_binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!getHeader(event.headers, 'content-type').includes('application/json')) {
    return { statusCode: 415, body: 'application/json required' };
  }
  let parsed: z.infer<typeof bodySchema>;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    parsed = bodySchema.parse(JSON.parse(raw || '{}'));
  } catch {
    return { statusCode: 400, body: 'Invalid body' };
  }

  const store = await getEditorialRequestsBlobStore(event);
  if (!(await consumeSweepToken(store, parsed.trigger_token))) {
    // A replay, a forged POST, or a token that outlived its TTL. 202-shaped
    // refusal: the caller is a scheduler, not a human, and there is nothing to
    // retry.
    console.warn('editorial request sweep run refused: bad or spent trigger token');
    return { statusCode: 409, body: 'stale or unknown trigger token' };
  }

  const deps = {
    store,
    ...(bridge() ? { bridge: bridge()! } : {}),
    ...(mailer() ? { mailer: mailer()! } : {}),
    chats: await chatSink(event),
    ...(context?.getRemainingTimeInMillis ? { remainingMs: () => context.getRemainingTimeInMillis!() } : {}),
  };

  try {
    // An explicit list (the scheduled tick's candidates) is swept as given; an
    // empty call re-selects from the index, so the worker is also usable on its own.
    // Sequential on purpose. `Promise.all` here put N concurrent
    // read-modify-write commits on the single index blob, which has no
    // compare-and-swap: a human's archive landing mid-pass lost its index
    // write, and the nudge counter's read-increment-write raced with itself.
    const outcomes: Awaited<ReturnType<typeof sweepRequest>>[] = [];
    if (parsed.request_ids?.length) {
      for (const id of parsed.request_ids) {
        if (context?.getRemainingTimeInMillis && context.getRemainingTimeInMillis() < 5_000) break;
        outcomes.push(await sweepRequest(deps, id));
      }
    } else {
      outcomes.push(...(await runSweep(deps)).outcomes);
    }
    const swept = outcomes.filter((outcome): outcome is NonNullable<typeof outcome> => Boolean(outcome));
    const moved = swept.filter((outcome) => outcome.changed);
    const unreachable = swept.filter((outcome) => outcome.unreachable);
    console.info('editorial request sweep run', {
      swept: swept.length,
      moved: moved.length,
      nudged: swept.filter((outcome) => outcome.nudged).length,
      repaired: swept.filter((outcome) => outcome.repaired).length,
      unreachable: unreachable.length,
      ...(unreachable.length ? { first_unreachable: unreachable[0]?.unreachable } : {}),
    });
    return { statusCode: 200, body: JSON.stringify({ swept: swept.length, moved: moved.length }) };
  } catch (error) {
    console.error('Editorial_Request_Sweep_Run failed.', error);
    return { statusCode: 500, body: 'sweep run failed' };
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
