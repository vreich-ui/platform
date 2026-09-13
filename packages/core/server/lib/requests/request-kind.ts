/**
 * The kind a request's OWN ID proves, and the reconciliation that lets a
 * wrongly-stamped record be corrected without a migration.
 *
 * #734 fixed the stamping bug at its source: `run_workspace_workflow` used to
 * register every job as `kind: 'article'` regardless of what actually ran, and
 * now resolves the kind from the catalog operation or the workflow id
 * (`agent/operation-catalog.ts`). That fix only reaches NEW registrations.
 * Every record stamped before it keeps the wrong word for ever — on
 * `site_zilberman` (2026-09-13) a capture run whose artifacts are images was
 * still listed as an Article, with no way to correct it from anywhere.
 *
 * Rather than a one-shot per-tenant backfill (which fixes one tenant and
 * leaves the mechanism intact), the correction lives in the read projection
 * and in registration itself, so every tenant converges on the truth on the
 * next index write and no new record can be stamped wrong by a caller that
 * forgot to resolve a kind.
 *
 * THE EVIDENCE IS DELIBERATELY NARROW. Editorial request ids are
 * `req_<flow>_<topic>_<yyyymmdd>_<nn>` (AGENTS.md naming), and only the flow
 * segment is read — never the topic, so `req_agent_capture_notes_…` stays an
 * article. An unknown flow (`agent`, anything new) yields no evidence at all;
 * this module never guesses `other`, because a wrong downgrade is as bad as
 * the wrong upgrade it is fixing.
 */
import type { RequestKind } from './store.js';

/**
 * Flow segment → the kind it proves. Closed on purpose, one entry per minter:
 * - `capture` — `create_capture_job`'s crawl jobs (`captureBridgeRequestId`
 *   and the operator-minted `req_capture_<site>_<day>_<nn>` family).
 * - `visref`  — `visual-reference-import.ts`'s mood-board mirror, whose
 *   artifacts are images (`VISUAL_REFERENCE_REQUEST_FLOW`).
 * `agent` is absent and must stay absent: it is the generic minter
 * (`mintWorkspaceRequestId`) and says nothing about what ran.
 */
const FLOW_KIND: Readonly<Record<string, RequestKind>> = Object.freeze({
  capture: 'capture',
  visref: 'media',
});

/** The flow segment of `req_<flow>_…`, or undefined for anything else. */
export const requestFlowSegment = (requestId: string): string | undefined => {
  const parts = requestId.split('_');
  return parts.length >= 3 && parts[0] === 'req' && parts[1] ? parts[1] : undefined;
};

/** The kind this id PROVES, or undefined when it proves nothing. Never a guess. */
export const requestKindFromId = (requestId: string): RequestKind | undefined => {
  const flow = requestFlowSegment(requestId);
  return flow ? FLOW_KIND[flow] : undefined;
};

/**
 * The kind to show for a request, given what is stored on it.
 *
 * Only `'article'` is treated as correctable, because `'article'` is the value
 * the pre-#734 bug wrote unconditionally — it is the one stamp that carries no
 * information. Every other stored kind was chosen deliberately by a resolver
 * and is left exactly as it is, even where the id would suggest otherwise.
 */
export const reconcileRequestKind = (input: { kind: RequestKind; request_id: string }): RequestKind => {
  if (input.kind !== 'article') return input.kind;
  return requestKindFromId(input.request_id) ?? input.kind;
};
