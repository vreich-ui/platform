/**
 * Conservative, presentation-only release review helpers. They do not decide
 * whether an object is deployable or mutate the release lifecycle; the server
 * remains the source of truth for published/live state.
 */
export interface ReleaseReviewItem {
  object_id: string;
  object_type: string;
  display_name: string;
}

export type ReleaseReviewCategory = 'ready' | 'likely_test' | 'reachability_unclear';

export interface ReleaseReviewGroup<T extends ReleaseReviewItem = ReleaseReviewItem> {
  category: ReleaseReviewCategory;
  label: string;
  description: string;
  items: T[];
}

const LIKELY_TEST_OR_PLACEHOLDER =
  /(?:^|[\s._-])(qa|test|field[-\s]?test|smoke|placeholder|sample|example|temp(?:orary)?|scratch|untitled)(?:$|[\s._-])/i;

/** Only these types have a direct, reader-facing route by convention. */
const CLEARLY_PUBLIC_TYPES = new Set(['page', 'content_item']);

export const isLikelyTestOrPlaceholder = (item: ReleaseReviewItem): boolean =>
  LIKELY_TEST_OR_PLACEHOLDER.test(`${item.display_name} ${item.object_id}`);

export const isClearlyPublicOrReachable = (item: ReleaseReviewItem): boolean =>
  CLEARLY_PUBLIC_TYPES.has(item.object_type);

export const releaseReviewCategoryFor = (item: ReleaseReviewItem): ReleaseReviewCategory => {
  if (isLikelyTestOrPlaceholder(item)) return 'likely_test';
  return isClearlyPublicOrReachable(item) ? 'ready' : 'reachability_unclear';
};

const GROUP_COPY: Record<Exclude<ReleaseReviewCategory, 'ready'>, Omit<ReleaseReviewGroup, 'items' | 'category'>> = {
  likely_test: {
    label: 'Review: likely QA, test, or placeholder content',
    description:
      'Names suggest these may be test or temporary records. They are not excluded; review before releasing.',
  },
  reachability_unclear: {
    label: 'Review: public reachability is not clear',
    description:
      'This object may support a public page, but this queue cannot prove a direct reader-facing route. Review its object page before releasing.',
  },
};

export const groupReleaseReviewItems = <T extends ReleaseReviewItem>(items: T[]): ReleaseReviewGroup<T>[] => {
  const grouped: Record<ReleaseReviewCategory, T[]> = {
    likely_test: [],
    reachability_unclear: [],
    ready: [],
  };
  for (const item of items) grouped[releaseReviewCategoryFor(item)].push(item);

  const groups: ReleaseReviewGroup<T>[] = [
    ...(['likely_test', 'reachability_unclear'] as const)
      .filter((category) => grouped[category].length > 0)
      .map((category) => ({ category, ...GROUP_COPY[category], items: grouped[category] })),
  ];
  if (grouped.ready.length > 0) {
    groups.push({
      category: 'ready',
      label: 'Published changes ready to release',
      description:
        'These records look reader-facing from their type and name. The server has already classified them as published, not live.',
      items: grouped.ready,
    });
  }
  return groups;
};

/** Commit ids are operational diagnostics, never primary editorial content. */
export const shortDiagnosticCommit = (commit: string | null | undefined): string | undefined => {
  const normalized = commit?.trim();
  return normalized ? normalized.slice(0, 8) : undefined;
};

export const releaseReviewSummary = (groups: ReleaseReviewGroup[]): string => {
  const count = (category: ReleaseReviewCategory) =>
    groups.find((group) => group.category === category)?.items.length ?? 0;
  const flagged = count('likely_test') + count('reachability_unclear');
  return flagged
    ? `${flagged} change${flagged === 1 ? '' : 's'} need${flagged === 1 ? 's' : ''} review before release.`
    : 'No conservative review flags were found in this batch.';
};

/** A confirmation is valid only for this exact human-visible published batch. */
export const releaseQueueSignature = (items: ReleaseReviewItem[]): string =>
  items
    .map((item) => `${item.object_id}:${item.display_name}`)
    .sort()
    .join('|');

/**
 * M1 — "as of hh:mm".
 *
 * `admin-release-state` and `admin-editorial-view` no longer compute the deploy
 * header on the page path; they read it from `snapshots/release.json`, which a
 * scheduled function refreshes every two minutes and the publish/release write
 * paths refresh immediately. That is a straight trade of freshness for latency
 * (14-16 s of Netlify and GitHub calls per page view, gone), and the honest way
 * to make that trade is to SAY how old the number is rather than let a reader
 * assume "now".
 *
 * Local time on purpose: the reader is a person deciding whether to press
 * Release, and "as of 14:32" answers "is this from before or after I published"
 * in their own clock. Seconds are noise at a two-minute cadence.
 *
 * `undefined` for an absent or unparseable stamp — the caller renders nothing
 * rather than "as of Invalid Date". A missing `as_of` is what an older function
 * deploy answers during a rollout, so this must degrade quietly.
 */
export const releaseAsOfLabel = (
  asOf: string | null | undefined,
  options: { locale?: string; timeZone?: string } = {}
): string | undefined => {
  if (!asOf) return undefined;
  const at = new Date(asOf);
  if (Number.isNaN(at.getTime())) return undefined;
  const formatted = at.toLocaleTimeString(options.locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
  return `as of ${formatted}`;
};

/**
 * How stale is too stale to show without comment. The refresh runs every two
 * minutes; three missed passes is the same bound the server uses to decide a
 * snapshot must be rebuilt (`RELEASE_SNAPSHOT_MAX_AGE_MS`). Past it, the label
 * says so — a server that is rebuilding on every read is a broken schedule, and
 * the person looking at the badge is the one who will notice first.
 */
export const RELEASE_AS_OF_STALE_MS = 10 * 60_000;

export const releaseAsOfIsStale = (asOf: string | null | undefined, nowMs: number): boolean => {
  if (!asOf) return false;
  const at = Date.parse(asOf);
  return Number.isFinite(at) && nowMs - at > RELEASE_AS_OF_STALE_MS;
};
