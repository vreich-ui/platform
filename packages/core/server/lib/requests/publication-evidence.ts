/**
 * Advisory approvals vs. genuine holds, and what the publish/release tail
 * actually did — read from the run's OWN evidence, never inferred from the
 * presence of an `approvalsRequired` entry.
 *
 * Found live 2026-08-31 (dr-lurie, "Retinol vs. bakuchiol", 24/24 nodes
 * complete, article live): the run card said "Waiting for your approval",
 * listed three entries and offered Approve/Reject — for a run that had already
 * published under the project's autonomous policy. CMS-Agent's
 * `workflow_get_run` writes one `approvalsRequired[]` entry per publish-risk
 * node it let through under `autonomyMode: "autonomous"`, tagged
 * `source: "policy_autonomous"` and worded "Advisory only — nothing is held".
 * Those are AUDIT records. A genuine hold (an operator-gated project, or an
 * operator's "withheld" veto) carries NO `source` at all on the wire — across
 * the 84 runs on the bridge on 2026-08-31, `policy_autonomous` is the only
 * value the field has ever held, and every held run omits it.
 *
 * Every consumer of `approvalsRequired` on this side (the activity projection,
 * the chat narrowing, the sweeper's status derivation) goes through
 * `isAdvisoryApproval` so the split is made in exactly one place.
 */

// ─── advisory approvals ──────────────────────────────────────────────────────

/**
 * `source` values that mean "recorded for the audit trail; nothing waits on a
 * human". Absent `source` is a hold — that is what CMS-Agent sends for one.
 */
export const ADVISORY_APPROVAL_SOURCES: readonly string[] = ['policy_autonomous'];

/** The wording CMS-Agent uses on an advisory record — the belt to `source`'s braces. */
const ADVISORY_REASON = /advisory only|nothing is held/i;

export interface ApprovalLike {
  source?: unknown;
  reason?: unknown;
  [key: string]: unknown;
}

export const isAdvisoryApproval = (entry: ApprovalLike | null | undefined): boolean => {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.source === 'string' && ADVISORY_APPROVAL_SOURCES.includes(entry.source)) return true;
  return typeof entry.reason === 'string' && ADVISORY_REASON.test(entry.reason);
};

// ─── publication evidence ────────────────────────────────────────────────────

export type PublicationState = 'live' | 'published_pending_release';

/**
 * What the publish/release tail did, from the executors' own outputs
 * (`publish_execution.v1`, `release_execution.v1`) where they are available
 * and from their compact-view warnings where they are not.
 *
 *   live                       — publish committed AND the release confirmed
 *                                production serves it (`release_executor`
 *                                `status: "executed"` / `productionConfirmed`).
 *   published_pending_release  — publish committed; the release has not
 *                                confirmed go-live (not run, blocked, or its
 *                                deploy poll gave up). The article is on
 *                                `main`; it is not necessarily on the site.
 *
 * Absent when the run has not committed a publish — the existing rendering
 * (running / held / failed) already says what is going on then.
 */
export interface PublicationEvidence {
  state: PublicationState;
  /** `production.article_path` from the publish receipt, e.g. '/retinol-vs-bakuchiol-sensitive-skin'. */
  article_path?: string;
  /** The export commit the publish produced. */
  commit?: string;
  /** Netlify deploy id from the release, when one was started. */
  deploy_id?: string;
  /** ISO time the object was published. */
  published_at?: string;
  /** `release_executor`'s own machine reason when go-live was not confirmed. */
  release_reason?: string;
  /** `release_executor`'s own blocker sentences, verbatim. */
  release_blockers?: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export interface PublicationNodeSnapshot {
  nodeId?: string | null;
  id?: string | null;
  status?: string | null;
  warnings?: unknown;
  output?: unknown;
}

const nodeIdOf = (node: PublicationNodeSnapshot): string | undefined => str(node.nodeId) ?? str(node.id);

/**
 * `node_get_latest_output` answers `{ output: { value } }`; the full run view
 * carries the value directly on `node.output`. Either is accepted.
 */
const outputValue = (raw: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(raw)) return undefined;
  if (isRecord(raw.value) && str(raw.value.artifact)) return raw.value;
  if (isRecord(raw.output)) return outputValue(raw.output);
  return raw;
};

const structuredPublishResult = (output: Record<string, unknown>): Record<string, unknown> | undefined => {
  const result = isRecord(output.result) ? output.result : undefined;
  if (!result) return undefined;
  if (isRecord(result.structuredContent)) return result.structuredContent;
  // Older receipts carry only the text content; parse it once, tolerantly.
  const content = Array.isArray(result.content) ? result.content : [];
  for (const entry of content) {
    if (isRecord(entry) && typeof entry.text === 'string') {
      try {
        const parsed: unknown = JSON.parse(entry.text);
        if (isRecord(parsed)) return parsed;
      } catch {
        // Not JSON — nothing to read.
      }
    }
  }
  return undefined;
};

const confirmedByVerification = (output: Record<string, unknown> | undefined): boolean => {
  if (!output) return false;
  const verification = isRecord(output.verification) ? output.verification : undefined;
  return verification?.productionConfirmed === true;
};

/** Warnings CMS-Agent writes on a release that did NOT confirm go-live. */
const RELEASE_NOT_CONFIRMED =
  /^(release_not_confirmed|deploy_not_confirmed|deploy_status_not_ready|release_execution_blocked|no_release_performed)/;

export const derivePublication = (
  nodes: readonly PublicationNodeSnapshot[],
  nodeOutputs: Readonly<Record<string, unknown>> = {}
): PublicationEvidence | undefined => {
  const publishNode = nodes.find((node) => nodeIdOf(node) === 'publish_executor');
  if (!publishNode) return undefined;
  const publish = outputValue(publishNode.output ?? nodeOutputs.publish_executor);
  const publishWarnings = strings(publishNode.warnings);
  const publishStatus = str(publish?.status);
  const receipt = publish ? structuredPublishResult(publish) : undefined;

  const committed = publish
    ? publish.publishCommitted === true ||
      publishStatus === 'executed' ||
      publishStatus === 'published_pending_release' ||
      receipt?.published === true
    : // Compact view: the warning is the only word the executor left behind.
      str(publishNode.status) === 'completed' &&
      publishWarnings.some((warning) => warning.startsWith('publish_committed_pending_release'));
  if (!committed) return undefined;

  const releaseNode = nodes.find((node) => nodeIdOf(node) === 'release_executor');
  const release = releaseNode ? outputValue(releaseNode.output ?? nodeOutputs.release_executor) : undefined;
  const releaseWarnings = releaseNode ? strings(releaseNode.warnings) : [];

  // "Live" needs the executors' OWN confirmation (`status: "executed"`, which
  // the output schema only permits with `deployStatus: "ready"` and
  // `productionConfirmed: true`). The compact view's warnings can prove a
  // publish was committed; they cannot prove a deploy was served, so without
  // an output the honest state is "pending" — never a fabricated "live".
  const live =
    publishStatus === 'executed' ||
    confirmedByVerification(publish) ||
    str(release?.status) === 'executed' ||
    confirmedByVerification(release);

  const production = receipt && isRecord(receipt.production) ? receipt.production : undefined;
  const receiptBlock = receipt && isRecord(receipt.receipt) ? receipt.receipt : undefined;
  const receipts = publish && isRecord(publish.receipts) ? publish.receipts : undefined;
  const articlePath = str(receipt?.article_path) ?? str(production?.article_path);
  const commit = str(receiptBlock?.commit_sha) ?? str(receipts?.commitSha) ?? str(release?.deployedSha);
  const deployId = str(release?.releaseId);
  const publishedAt = str(receipt?.published_time) ?? str(receipts?.publishedTime);
  const releaseReason = live
    ? undefined
    : (str(release?.reason) ?? releaseWarnings.find((w) => RELEASE_NOT_CONFIRMED.test(w)));
  const releaseBlockers = live ? [] : strings(release?.blockers);

  return {
    state: live ? 'live' : 'published_pending_release',
    ...(articlePath ? { article_path: articlePath } : {}),
    ...(commit ? { commit } : {}),
    ...(deployId ? { deploy_id: deployId } : {}),
    ...(publishedAt ? { published_at: publishedAt } : {}),
    ...(releaseReason ? { release_reason: releaseReason } : {}),
    ...(releaseBlockers.length > 0 ? { release_blockers: releaseBlockers } : {}),
  };
};

/**
 * Whether the run has reached the point where the executors' outputs are worth
 * a read: `publish_executor` is settled. Before that there is nothing to fetch,
 * and this keeps the polled endpoints to their two reads for the whole of a
 * run's working life.
 */
export const publicationOutputsWorthReading = (nodes: readonly PublicationNodeSnapshot[]): boolean =>
  nodes.some((node) => nodeIdOf(node) === 'publish_executor' && str(node.status) === 'completed');
