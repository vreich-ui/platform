/**
 * Function name: Visual_Standard_Examples_Run (A6) — Netlify BACKGROUND
 * function (`-background` suffix: 202 to the caller, 15-minute budget), the
 * same shape as `editorial-request-sweep-background`.
 *
 * WHY A BACKGROUND FUNCTION. X1 generated a visual standard's example images
 * INLINE inside the MCP verb dispatch, with a ~10-second wait. flux needs far
 * longer than that, so the usual outcome was three real, paid image jobs
 * created and then dropped ("partial failure is never an error"), with no
 * status anywhere for a human to read. This function is where that work now
 * happens: it has the budget, and it writes what happened — per usage context —
 * onto the job record (`visual-standard-examples-jobs.ts`) that the trigger
 * opened as `pending`.
 *
 * AUTHORIZATION is the one-shot token the trigger minted into the job record,
 * consumed on start — the mechanic the editorial sweep and the chat loop both
 * use. A background function is a PUBLIC HTTP endpoint and this one's side
 * effects cost money (up to three flux jobs per call), so an unauthenticated
 * POST must not be able to spend it.
 *
 * WHY IT CONFIGURES MCP. The generation itself is `mcp-tool-handlers.ts`'s
 * `runVisualStandardExamplesGeneration` — deliberately the SAME code path,
 * deps and prompt assembly X1 already proved, not a second implementation. That
 * module reaches the object store through the injected sibling handlers, so
 * this function wires the governed trio for its OWN process exactly as a site's
 * `/mcp` shim does for its own. Netlify bundles every function separately, so
 * this configuration is this function's alone.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getHeader } from '../lib/admin-auth.js';
import { getArtifactIndexBlobStore } from '../lib/blob-store.js';
import {
  consumeExamplesJobToken,
  finishExamplesJob,
  type ExamplesJobStore,
} from '../lib/visual-standard-examples-jobs.js';
// IMPORT ORDER IS LOAD-BEARING: `mcp.ts` and `mcp-tool-handlers.ts` are a
// module cycle (the handlers reach the object store through mcp.ts's injected
// siblings; mcp.ts dispatches to the handlers). `mcp.ts` must be the module
// this file enters that cycle through — entering it from the handlers' side
// hits a TDZ ReferenceError on mcp.ts's own consts. Every other entry point
// (each site's `/mcp` shim) enters the same way.
import { configureMcp, type LambdaEvent as McpLambdaEvent } from './mcp.js';
import { runVisualStandardExamplesGeneration } from '../lib/mcp-tool-handlers.js';
import { createHandler as createSaveArtifactHandler } from './save-artifact.js';
import { createHandler as createObjectStoreHandler } from './object-store.js';
import { createHandler as createDeployStatusHandler } from './deploy-status.js';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

const parseBody = (event: LambdaEvent): { visualStandardId: string; triggerToken: string } | undefined => {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
    const visualStandardId = typeof parsed.visual_standard_id === 'string' ? parsed.visual_standard_id.trim() : '';
    const triggerToken = typeof parsed.trigger_token === 'string' ? parsed.trigger_token.trim() : '';
    if (!visualStandardId || !triggerToken) return undefined;
    return { visualStandardId, triggerToken };
  } catch {
    return undefined;
  }
};

const buildHandlerImpl = (binding: SiteBinding) => {
  // Lazily, once per process, and never at module load: a shim is imported in
  // places (tests, bundlers) where configuring another module's globals as a
  // side effect of an import would be a surprise.
  let configured = false;
  const configureSiblings = () => {
    if (configured) return;
    configureMcp({
      saveArtifactHandler: createSaveArtifactHandler(binding),
      objectStoreHandler: createObjectStoreHandler(binding),
      deployStatusHandler: createDeployStatusHandler(binding),
    });
    configured = true;
  };

  return async (event: LambdaEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
    if (!getHeader(event.headers, 'content-type').includes('application/json')) {
      return { statusCode: 415, body: 'application/json required' };
    }
    const parsed = parseBody(event);
    if (!parsed) return { statusCode: 400, body: 'Invalid body' };

    configureSiblings();

    const store = (await getArtifactIndexBlobStore(event)) as unknown as ExamplesJobStore;
    const claimed = await consumeExamplesJobToken(store, parsed.visualStandardId, parsed.triggerToken);
    if (!claimed) {
      // A replay, a forged POST, or a token already spent. 409-shaped refusal:
      // the caller is a trigger, not a human, and there is nothing to retry.
      console.warn('visual standard examples run refused: bad or spent trigger token');
      return { statusCode: 409, body: 'stale or unknown trigger token' };
    }

    try {
      const outcome = await runVisualStandardExamplesGeneration(event as McpLambdaEvent, parsed.visualStandardId);
      await finishExamplesJob(store, parsed.visualStandardId, {
        status: outcome.status,
        contexts: outcome.contexts,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        nowMs: Date.now(),
      });
      console.info('visual standard examples run', {
        visualStandardId: parsed.visualStandardId,
        status: outcome.status,
        contexts: outcome.contexts.length,
      });
      return { statusCode: 200, body: JSON.stringify({ examples_status: outcome.status }) };
    } catch (error) {
      console.error('Visual_Standard_Examples_Run failed.', error);
      // The record must never be left saying `pending` for ever.
      await finishExamplesJob(store, parsed.visualStandardId, {
        status: 'failed',
        contexts: [],
        reason: 'run_failed',
        nowMs: Date.now(),
      }).catch(() => undefined);
      return { statusCode: 500, body: 'examples run failed' };
    }
  };
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
