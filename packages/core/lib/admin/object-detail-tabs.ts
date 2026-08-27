/**
 * Object detail — tab data derivation (T2.2).
 *
 * Four tabs: Content / Versions / Usage / Activity. Three of them are
 * derived, purely, from data the object workspace ALREADY has in hand:
 *
 *  - **Versions** and **Activity** both come from `ObjectRecord.history`
 *    (`schema/object-record-v1.ts`'s `historyEntrySchema`) plus
 *    `publication.publish_receipt` — the same audit trail `HistoryTimeline`
 *    renders today and `structural-diff.ts` already reads `details.capture`
 *    from. No endpoint was invented: T0.1 §7 confirms `object_get` is the
 *    only per-object read the admin has, and it returns the full history.
 *    Activity is every entry; Versions is the subset that actually moved the
 *    content (a patch capture, a publish, a review decision, a discard).
 *
 *  - **Usage** ("what else points at this object") has NO client-reachable
 *    backing data. The referrer graph exists server-side — `referrerIndex()`
 *    in `server/lib/object-verbs.ts` — but it is built inside the `retire`
 *    verb and surfaced only as the `still_referenced` 409's `referrers`
 *    array; no read verb exposes it, and T0.1 §7 lists no `object_usage`
 *    tool on any of the three verb surfaces. So `deriveUsage` returns an
 *    honest unavailable state naming exactly what would populate it, and the
 *    surface renders that instead of a fabricated panel.
 */
import type { HistoryEntry, ObjectRecord } from '../../schema/object-record-v1.js';
import { principalName, verbToPhrase } from './display-name.js';

export const OBJECT_DETAIL_TABS = ['content', 'versions', 'usage', 'activity'] as const;
export type ObjectDetailTab = (typeof OBJECT_DETAIL_TABS)[number];

const TAB_SET = new Set<string>(OBJECT_DETAIL_TABS);

/** `?tab=` round-trip; anything unknown falls back to Content. */
export const parseDetailTab = (raw: string | null | undefined): ObjectDetailTab =>
  raw && TAB_SET.has(raw) ? (raw as ObjectDetailTab) : 'content';

type RecordLike = Pick<ObjectRecord<Record<string, unknown>>, 'history' | 'publication' | 'content_revision'>;

// ─── Versions ───────────────────────────────────────────────────────────────

export type VersionChangeKind = 'edit' | 'publish' | 'review' | 'discard';

export interface VersionEntry {
  /** Index into `record.history` — stable handle for anything that needs the raw entry. */
  historyIndex: number;
  at: string;
  actor: string;
  kind: VersionChangeKind;
  /** One-line description, from the shared verb phrasebook. */
  summary: string;
  /** Body field names this entry touched, when the capture says so. */
  changedFields: string[];
  /** True for the entry whose export is the object's current published state. */
  isCurrentPublish: boolean;
}

const CAPTURE_KIND_LABEL: Record<string, string> = {
  fields: 'field edit',
  element: 'structural change',
  move: 'reorder',
};

const captureOf = (entry: HistoryEntry): { kind?: string; before?: unknown; after?: unknown } | undefined => {
  const details = entry.details as { capture?: { kind?: string; before?: unknown; after?: unknown } } | undefined;
  return details?.capture;
};

const changedFieldNames = (entry: HistoryEntry): string[] => {
  const capture = captureOf(entry);
  if (!capture || capture.kind !== 'fields') return [];
  const after = capture.after;
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return [];
  return Object.keys(after as Record<string, unknown>);
};

const versionKind = (entry: HistoryEntry): VersionChangeKind | undefined => {
  if (entry.action === 'discard') return 'discard';
  if (entry.action === 'review_decide' || entry.action === 'submit_review') return 'review';
  if (entry.action.startsWith('publish')) return 'publish';
  if (captureOf(entry)) return 'edit';
  return undefined;
};

/**
 * The version list: history entries that moved the content or its approval,
 * newest first. Lock churn (checkout/checkin/refresh_lock) is excluded — it
 * bumps `version` without changing anything an editor would call a version,
 * which is exactly the distinction `content_revision` exists to draw
 * (`review-state.ts`'s D§3.9 note).
 */
export const deriveVersionEntries = (record: RecordLike): VersionEntry[] => {
  const publishedCommit = record.publication?.publish_receipt?.commit_sha;
  const entries: VersionEntry[] = [];
  record.history.forEach((entry, historyIndex) => {
    const kind = versionKind(entry);
    if (!kind) return;
    const capture = captureOf(entry);
    const captureLabel = capture?.kind ? CAPTURE_KIND_LABEL[capture.kind] : undefined;
    const receipt = (entry.details as { publish_receipt?: { commit_sha?: string } } | undefined)?.publish_receipt;
    entries.push({
      historyIndex,
      at: entry.at,
      actor: principalName(entry.actor),
      kind,
      summary: captureLabel ? `${verbToPhrase(entry)} (${captureLabel})` : verbToPhrase(entry),
      changedFields: changedFieldNames(entry),
      isCurrentPublish: kind === 'publish' && publishedCommit !== undefined && receipt?.commit_sha === publishedCommit,
    });
  });
  return entries.reverse();
};

// ─── Activity ───────────────────────────────────────────────────────────────

/**
 * Every history entry, newest first — the full audit trail, lock churn
 * included, because "who held this and when" is exactly what an activity
 * view is for. Returned as raw `HistoryEntry[]` so the existing
 * `<HistoryTimeline>` renders it unchanged.
 */
export const deriveActivityEntries = (record: Pick<RecordLike, 'history'>): HistoryEntry[] =>
  record.history.slice().reverse();

// ─── Usage ──────────────────────────────────────────────────────────────────

export interface UsageState {
  /** False today for every object type — see the module comment. */
  available: false;
  /** Editor-facing reason. */
  message: string;
  /** The real, named sources that would fill this tab if they were exposed. */
  wouldBePopulatedBy: readonly string[];
}

export const deriveUsage = (): UsageState => ({
  available: false,
  message: 'Nothing reads a reference graph for this object yet, so there is nothing honest to show here.',
  wouldBePopulatedBy: [
    'the referrer index the retire verb builds server-side (object-verbs.ts) — it names referrers today only inside a 409 refusal, and no read verb exposes it',
    'page/section instantiation provenance (a page records the template it came from, but nothing indexes the reverse)',
    'published-route analytics, which this admin has no endpoint for',
  ],
});
