export type EditorialObjectState = 'draft' | 'approved' | 'published' | 'live';

export type ApprovalState = 'none' | 'open' | 'changes_requested' | 'approved_stale' | 'approved_current';

export interface EditorialStateRecord {
  content_revision: number;
  requires_approval?: boolean;
  approval_state?: ApprovalState;
  review?: {
    state?: 'open' | 'changes_requested' | 'approved';
    decisions?: Array<{ decision?: 'approve' | 'request_changes'; content_revision?: number }>;
  } | null;
  publication?: {
    published_time?: string | null;
    publish_receipt?: {
      content_revision?: number;
      commit_sha?: string;
    } | null;
  } | null;
  published_time?: string | null;
  published_content_revision?: number | null;
  publish_commit?: string | null;
}

export interface EditorialDeployState {
  production_confirmed: boolean;
  live_commit?: string;
  included_commits?: readonly string[];
  status?: 'unavailable' | 'idle' | 'queued' | 'building' | 'ready' | 'ready_not_published' | 'failed' | 'stalled';
}

export interface EditorialDeployReceiptView {
  commit?: string;
  deployStatus: 'queued' | 'building' | 'ready' | 'failed' | 'canceled' | 'timed_out';
  startedAt?: string;
}

export function getEditorialDeployStatus(
  latest: EditorialDeployReceiptView | undefined,
  publishedCommit: string | undefined,
  nowMs = Date.now()
): NonNullable<EditorialDeployState['status']> {
  if (!latest) return publishedCommit ? 'ready' : 'idle';
  if (latest.deployStatus === 'failed' || latest.deployStatus === 'canceled') return 'failed';
  if (latest.deployStatus === 'timed_out') return 'stalled';
  if (latest.deployStatus === 'queued' || latest.deployStatus === 'building') {
    const started = Date.parse(latest.startedAt ?? '');
    return Number.isFinite(started) && nowMs - started > 15 * 60_000 ? 'stalled' : latest.deployStatus;
  }
  if (latest.deployStatus === 'ready' && publishedCommit && latest.commit && latest.commit !== publishedCommit) {
    return 'ready_not_published';
  }
  return 'ready';
}

const approvalStateOf = (record: EditorialStateRecord): ApprovalState => {
  if (record.approval_state) return record.approval_state;
  const review = record.review;
  if (!review) return 'none';
  if (review.state === 'open') return 'open';
  if (review.state === 'changes_requested') return 'changes_requested';
  const last = review.decisions?.at(-1);
  if (!last || last.decision !== 'approve') return 'none';
  return last.content_revision === record.content_revision ? 'approved_current' : 'approved_stale';
};

const publicationOf = (record: EditorialStateRecord) => {
  const receipt = record.publication?.publish_receipt;
  return {
    publishedTime: record.publication?.published_time ?? record.published_time ?? null,
    publishedRevision: receipt?.content_revision ?? record.published_content_revision ?? null,
    commit: receipt?.commit_sha ?? record.publish_commit ?? null,
  };
};

/**
 * The one editorial lifecycle derivation. It never writes status and never
 * treats a merely-ready build as live: `live` requires the server-confirmed
 * production deploy to include this exact export commit.
 */
export function getEditorialObjectState(
  record: EditorialStateRecord,
  deployState: EditorialDeployState
): EditorialObjectState {
  const publication = publicationOf(record);
  const currentExport = Boolean(publication.publishedTime) && publication.publishedRevision === record.content_revision;

  if (currentExport) {
    const included = new Set(deployState.included_commits ?? []);
    const isLive =
      deployState.production_confirmed &&
      Boolean(publication.commit) &&
      (publication.commit === deployState.live_commit || included.has(publication.commit ?? ''));
    return isLive ? 'live' : 'published';
  }

  if (record.requires_approval && approvalStateOf(record) === 'approved_current') return 'approved';
  return 'draft';
}

export const EDITORIAL_STATE_PRESENTATION: Record<
  EditorialObjectState,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' }
> = {
  draft: { label: 'Draft', tone: 'neutral' },
  approved: { label: 'Approved', tone: 'info' },
  published: { label: 'Published', tone: 'warning' },
  live: { label: 'Live', tone: 'success' },
};

/** The lifecycle presented on an object's status pill when release state couldn't be confirmed. */
export type ReleaseAwareLifecycle = EditorialObjectState | 'unknown';

export const RELEASE_UNKNOWN_PRESENTATION: { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' } = {
  label: 'Unknown',
  tone: 'warning',
};

/**
 * Fail-closed lifecycle resolution (fixed defect: Publish rendering when
 * release state is unknown). A client can only ever trust a server-confirmed
 * release-state row for this object — when the release overview couldn't be
 * loaded, or this object isn't in it, the truthful answer is "unknown," never
 * a value fabricated from partial/default client data (which previously
 * showed a live approved object as Draft, or a gated unapproved object as
 * publishable). Never call `getEditorialObjectState` as a substitute when the
 * release row is missing — it needs `production_confirmed`/deploy facts only
 * the server can supply.
 */
export function resolveReleaseAwareLifecycle(
  releaseObject: { state: EditorialObjectState } | undefined
): ReleaseAwareLifecycle {
  return releaseObject?.state ?? 'unknown';
}

/** Status-pill presentation for a `ReleaseAwareLifecycle`, including the unknown case. */
export function releaseAwareLifecyclePresentation(lifecycle: ReleaseAwareLifecycle): {
  label: string;
  tone: 'neutral' | 'info' | 'success' | 'warning';
} {
  return lifecycle === 'unknown' ? RELEASE_UNKNOWN_PRESENTATION : EDITORIAL_STATE_PRESENTATION[lifecycle];
}
