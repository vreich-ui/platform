import { useCallback, useEffect, useMemo, useState } from 'react';
import { navigate } from 'astro:transitions/client';

import { AdminShell } from './AdminShell';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { Switch } from './forms';
import { ConfirmDialog, useToast } from './overlays';
import { ActionRow } from './approval';
import { IconCheck, IconExternalLink, IconRocket } from './icons';
import type { SiteIdentity } from '@core/lib/site-identity';
import { fetchInventoryRows } from '@core/lib/admin/library-client';
import { listChats, type ChatSummaryView } from '@core/lib/admin/chat-client';
import {
  fetchReleaseOverview,
  triggerProductionRelease,
  type ReleaseDeployState,
  type ReleaseObjectView,
  type ReleaseOverview,
  type ReleaseResultView,
} from '@core/lib/admin/release-client';
import { chatWorkLabel, getWorkSummary } from '@core/lib/admin/work-summary';
import type { LibraryRow } from '@core/lib/admin/library-logic';
import {
  groupReleaseReviewItems,
  releaseQueueSignature,
  releaseReviewSummary,
  shortDiagnosticCommit,
  type ReleaseReviewGroup,
} from '@core/lib/admin/release-presentation';
import { assertDecided, decide, decisionAvailability, type DecisionAction } from '@core/lib/admin/decisions';
import { forceReleaseObjectLock } from '@core/lib/edit-mode/verbs-client';
import { useCurrentUser } from '@core/lib/admin/use-current-user';

async function getToken(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

const objectHref = (item: { object_id: string; object_type: string }) =>
  `/admin/content/${encodeURIComponent(item.object_id)}?type=${item.object_type}`;

const deployCopy: Record<
  ReleaseDeployState,
  { label: string; message: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
> = {
  unavailable: {
    label: 'Release status unavailable',
    message: 'Production deploy lookup is not configured for this publication.',
    tone: 'warning',
  },
  idle: { label: 'No release yet', message: 'Production has not reported a confirmed release.', tone: 'neutral' },
  queued: { label: 'Release queued', message: 'The production build is waiting to start.', tone: 'info' },
  building: { label: 'Building', message: 'The production release is being built.', tone: 'info' },
  ready: {
    label: 'Production live',
    message: 'The latest confirmed production deployment is healthy.',
    tone: 'success',
  },
  ready_not_published: {
    label: 'Built, not live',
    message: 'The build completed but production still serves an older release. Publishing may be locked in Netlify.',
    tone: 'warning',
  },
  failed: {
    label: 'Release failed',
    message: 'The latest production build failed. Review the deploy log before retrying.',
    tone: 'danger',
  },
  stalled: {
    label: 'Release stalled',
    message: 'The build has not made progress within the expected window. Check Netlify before retrying.',
    tone: 'danger',
  },
};

function ObjectList({ items, empty }: { items: ReleaseObjectView[]; empty?: string }) {
  if (!items.length) {
    return empty ? <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{empty}</p> : null;
  }
  return (
    <div className="divide-y divide-[var(--adm-border)]">
      {items.map((item) => (
        <a
          key={item.object_id}
          href={objectHref(item)}
          className="adm-focusable flex items-center justify-between gap-3 rounded px-1 py-3 hover:text-[var(--adm-accent)]"
        >
          <span className="min-w-0 truncate font-medium">{item.display_name}</span>
          <IconExternalLink size={15} />
        </a>
      ))}
    </div>
  );
}

function WorkList({ chats, empty }: { chats: ChatSummaryView[]; empty: string }) {
  if (!chats.length) return <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{empty}</p>;
  return (
    <div className="divide-y divide-[var(--adm-border)]">
      {chats.map((chat) => {
        const content = (
          <>
            <span className="min-w-0 truncate font-medium">{chat.title}</span>
            <Badge tone={chat.status === 'error' ? 'danger' : chat.status.startsWith('awaiting') ? 'warning' : 'info'}>
              {chatWorkLabel(chat)}
            </Badge>
          </>
        );
        return chat.object_id && chat.object_type ? (
          <a
            key={chat.chat_id}
            href={objectHref({ object_id: chat.object_id, object_type: chat.object_type })}
            className="adm-focusable flex items-center justify-between gap-3 rounded px-1 py-3 hover:text-[var(--adm-accent)]"
          >
            {content}
          </a>
        ) : (
          <div key={chat.chat_id} className="flex items-center justify-between gap-3 py-3">
            {content}
          </div>
        );
      })}
    </div>
  );
}

/**
 * T3.2 (T0.3 row A6) — the "Pending approvals" row, with the decision on it.
 *
 * These are objects with an OPEN review: the object-review mechanism (T0.1
 * §6.1), which is a different mechanism from the run gate the inbox decides
 * and from the chat tool card — the façade dispatches on the variant so this
 * surface does not have to know that. `review_decide` needs no lock and no
 * record version, which is why a row here can decide without checking the
 * object out.
 *
 * Reject is `request_changes`, the half of the verb that had no client method
 * at all before this task (T0.1 §7: "approve only, no request-changes UI").
 * There is no Modify: the object store records exactly two review decisions,
 * and `decisionAvailability` says so rather than rendering a third button.
 */
function ApprovalDecisionRow({
  item,
  canForceRelease,
  onDecide,
  onForceRelease,
}: {
  item: ReleaseObjectView;
  canForceRelease: boolean;
  onDecide: (item: ReleaseObjectView, decision: DecisionAction, reason?: string) => Promise<void>;
  onForceRelease: (item: ReleaseObjectView) => void;
}) {
  const availability = decisionAvailability({
    mechanism: 'object_review',
    objectType: item.object_type,
    objectId: item.object_id,
  });
  return (
    <li className="flex flex-col gap-2 border-b border-[var(--adm-border)] py-3 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <a
          href={objectHref(item)}
          className="adm-focusable min-w-0 truncate rounded font-medium hover:text-[var(--adm-accent)]"
        >
          {item.display_name}
        </a>
        <Badge tone={item.requires_approval ? 'warning' : 'neutral'}>
          {item.requires_approval ? 'Approval required' : 'In review'}
        </Badge>
      </div>
      <ActionRow
        onApprove={() => onDecide(item, 'approve')}
        onReject={(reason) => onDecide(item, 'reject', reason)}
        approveLabel="Approve"
        rejectLabel="Reject"
        rejectReason={availability.reasonReaches.reject ? 'optional' : 'none'}
        secondary={
          <>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<IconExternalLink size={14} />}
              onClick={() => void navigate(objectHref(item))}
            >
              Open object
            </Button>
            {/* T0.3 row A8 — a LOCK action, deliberately not a decision and
                deliberately not on the façade. The readiness checklist tells
                editors to "wait or force-release" and nothing anywhere wired
                the verb; this is the button that copy promised. Owner-only,
                exactly as the endpoint enforces. */}
            {canForceRelease ? (
              <Button size="sm" variant="ghost" onClick={() => onForceRelease(item)}>
                Force-release lock
              </Button>
            ) : null}
          </>
        }
      />
    </li>
  );
}

function ApprovalDecisionList({
  items,
  empty,
  canForceRelease,
  onDecide,
  onForceRelease,
}: {
  items: ReleaseObjectView[];
  empty?: string;
  canForceRelease: boolean;
  onDecide: (item: ReleaseObjectView, decision: DecisionAction, reason?: string) => Promise<void>;
  onForceRelease: (item: ReleaseObjectView) => void;
}) {
  if (!items.length) {
    return empty ? <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{empty}</p> : null;
  }
  return (
    <ul className="flex flex-col">
      {items.map((item) => (
        <ApprovalDecisionRow
          key={item.object_id}
          item={item}
          canForceRelease={canForceRelease}
          onDecide={onDecide}
          onForceRelease={onForceRelease}
        />
      ))}
    </ul>
  );
}

/**
 * T3.2 (T0.3 row A7) — the two "Review:" groups get an acknowledge control.
 *
 * These are needs-you states by every definition in D4 (a human must look
 * before releasing) that had no way at all to say "looked, proceed". There is
 * no backend verb for this and this task does not invent one: the
 * acknowledgement is LOCAL and per-batch, keyed to the same queue signature
 * the "I reviewed this batch" switch already resets against, and the release
 * button's own gate is unchanged. What it buys is that the reviewer can see
 * which groups they have been through and the batch card can say how many are
 * outstanding — which is the honest version of the missing affordance, not a
 * button pretending to write a server record.
 */
function ReleaseReviewGroupCard({
  group,
  acknowledged,
  onAcknowledge,
}: {
  group: ReleaseReviewGroup<ReleaseObjectView>;
  acknowledged: boolean;
  onAcknowledge: (category: string, next: boolean) => void;
}) {
  const tone = group.category === 'ready' ? 'success' : 'warning';
  const needsLook = group.category !== 'ready';
  return (
    <Card>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-[var(--adm-text-heading)]">{group.label}</h2>
          <p className="mt-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{group.description}</p>
        </div>
        <Badge tone={acknowledged ? 'success' : tone}>{group.items.length}</Badge>
      </div>
      <ObjectList items={group.items} />
      {needsLook ? (
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            variant={acknowledged ? 'ghost' : 'secondary'}
            leftIcon={acknowledged ? <IconCheck size={14} /> : undefined}
            onClick={() => onAcknowledge(group.category, !acknowledged)}
          >
            {acknowledged ? 'Reviewed' : 'Mark reviewed'}
          </Button>
          <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {acknowledged
              ? 'Noted for this batch — it resets if the batch changes.'
              : 'Says you have looked at these before releasing. Recorded on this screen only.'}
          </span>
        </div>
      ) : null}
    </Card>
  );
}

function ReleaseWorkspaceContent() {
  const { toast } = useToast();
  const [overview, setOverview] = useState<ReleaseOverview>();
  const [chats, setChats] = useState<ChatSummaryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string>();
  const [lastResult, setLastResult] = useState<ReleaseResultView>();
  const [reviewedQueueSignature, setReviewedQueueSignature] = useState<string>();
  // T3.2 (A7): per-group acknowledgement, local and per-batch — see
  // `ReleaseReviewGroupCard`'s comment for why it is not a server record.
  const [acknowledged, setAcknowledged] = useState<{ signature?: string; categories: string[] }>({ categories: [] });
  const [forceTarget, setForceTarget] = useState<ReleaseObjectView | null>(null);
  const currentUser = useCurrentUser();
  const canForceRelease = currentUser.roles.includes('owner');

  const refresh = useCallback(async () => {
    try {
      const [nextOverview, rows, chatResult] = await Promise.all([
        // T5.1 R2: this surface's explicit refresh must bypass the new
        // module TTL for the same reason it already bypasses the inventory
        // one — the human pressed Refresh, or just released.
        fetchReleaseOverview(getToken, { force: true }),
        fetchInventoryRows(getToken, { force: true }),
        listChats(getToken).catch((): { chats: ChatSummaryView[] } => ({ chats: [] })),
      ]);
      setOverview(nextOverview);
      setChats(chatResult.chats);
      setError(undefined);
      return rows;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Release state could not be loaded.');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const [rows, setRows] = useState<LibraryRow[]>([]);
  useEffect(() => {
    void refresh().then(setRows);
  }, [refresh]);

  useEffect(() => {
    if (!overview || !['queued', 'building', 'ready_not_published'].includes(overview.deploy.state)) return;
    const timer = window.setInterval(() => void refresh().then(setRows), 6000);
    return () => window.clearInterval(timer);
  }, [overview?.deploy.state, refresh]);

  const work = useMemo(() => getWorkSummary(rows, chats), [rows, chats]);
  const waiting = useMemo(() => overview?.objects.filter((object) => object.state === 'published') ?? [], [overview]);
  const approvals = useMemo(
    () => overview?.objects.filter((object) => object.review_state === 'open') ?? [],
    [overview]
  );
  const reviewGroups = useMemo(() => groupReleaseReviewItems(waiting), [waiting]);
  const queueSignature = useMemo(() => releaseQueueSignature(waiting), [waiting]);
  const reviewed = waiting.length > 0 && reviewedQueueSignature === queueSignature;
  const deploy = overview ? deployCopy[overview.deploy.state] : undefined;
  // The acknowledgement set belongs to ONE batch — the moment the queue
  // changes it is stale, exactly like the "I reviewed this batch" switch.
  const acknowledgedCategories = acknowledged.signature === queueSignature ? acknowledged.categories : [];
  const groupsNeedingLook = reviewGroups.filter((group) => group.category !== 'ready');
  const outstandingGroups = groupsNeedingLook.filter(
    (group) => !acknowledgedCategories.includes(group.category)
  ).length;

  const acknowledgeGroup = (category: string, next: boolean) => {
    setAcknowledged((current) => {
      const base = current.signature === queueSignature ? current.categories : [];
      return {
        signature: queueSignature,
        categories: next ? [...new Set([...base, category])] : base.filter((entry) => entry !== category),
      };
    });
  };

  /**
   * T3.2 (A6) — an object review decision, through the one façade. Different
   * mechanism from the inbox's run gate, identical call shape here; the
   * façade also invalidates the shared request index, so a request bound to
   * this object stops showing as waiting on the other two surfaces.
   */
  const decideApproval = async (item: ReleaseObjectView, decision: DecisionAction, reason?: string) => {
    const result = await decide(
      getToken,
      {
        mechanism: 'object_review',
        objectType: item.object_type,
        objectId: item.object_id,
        displayName: item.display_name,
      },
      decision,
      reason ? { reason } : {}
    );
    assertDecided(result);
    toast({ title: item.display_name, description: result.receipt, tone: 'success' });
    setRows(await refresh());
  };

  const runForceRelease = async (item: ReleaseObjectView) => {
    setForceTarget(null);
    const result = await forceReleaseObjectLock(getToken, item.object_type, item.object_id);
    if (result.status !== 200) {
      toast({
        title: 'Lock not released',
        description: typeof result.body.error === 'string' ? result.body.error : undefined,
        tone: 'danger',
      });
      return;
    }
    toast({
      title: item.display_name,
      // The verb is idempotent and says so; repeating the server's own word
      // beats claiming a lock was broken that was never held.
      description: result.body.released
        ? 'The edit lock was force-released. Whoever held it will have to check out again.'
        : 'No lock was held — nothing to release.',
      tone: 'success',
    });
    setRows(await refresh());
  };

  const release = async () => {
    if (!reviewed || waiting.length === 0) return;
    setReleasing(true);
    try {
      const result = await triggerProductionRelease(getToken);
      setLastResult(result);
      toast({
        title: result.released ? 'Release is live' : 'Release started',
        description: result.reason,
        tone: result.released ? 'success' : 'info',
      });
      setRows(await refresh());
    } catch (reason) {
      toast({
        title: 'Release could not start',
        description: reason instanceof Error ? reason.message : undefined,
        tone: 'danger',
      });
    } finally {
      setReleasing(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]">Release</h1>
          <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            Publish objects first, then send the accumulated changes live in one production build.
          </p>
        </div>
        <Button
          leftIcon={<IconRocket size={16} />}
          onClick={() => void release()}
          loading={releasing}
          disabled={loading || waiting.length === 0 || !reviewed}
        >
          Release after review
        </Button>
      </header>

      {loading ? (
        <Skeleton variant="rect" height={420} />
      ) : error || !overview || !deploy ? (
        <EmptyState severity="error" title="Release unavailable" message={error} />
      ) : (
        <>
          <Card className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Badge tone={deploy.tone}>{deploy.label}</Badge>
                {overview.deploy.published?.production_url ? (
                  <a
                    href={overview.deploy.published.production_url}
                    target="_blank"
                    rel="noreferrer"
                    className="adm-focusable rounded text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-accent)] hover:underline"
                  >
                    View publication
                  </a>
                ) : null}
              </div>
              <p className="mt-2 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{deploy.message}</p>
              {lastResult ? (
                <p className="mt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                  {lastResult.reason}
                </p>
              ) : null}
            </div>
            <p className="text-right text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
              {waiting.length} published change{waiting.length === 1 ? '' : 's'} waiting to go live
            </p>
          </Card>

          <Card>
            <div className="flex flex-col gap-3">
              <div>
                <h2 className="font-semibold text-[var(--adm-text-heading)]">Review this release batch</h2>
                <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                  {releaseReviewSummary(reviewGroups)} Releasing sends every published change below in one production
                  build.
                </p>
                <p className="mt-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                  One production build will be requested and may use one build credit. A completed build is not
                  described as live until production confirms it.
                </p>
              </div>
              <Switch
                checked={reviewed}
                onCheckedChange={(checked) => setReviewedQueueSignature(checked ? queueSignature : undefined)}
                disabled={waiting.length === 0 || releasing}
                label="I reviewed this batch and understand it starts one production build."
                hint={
                  outstandingGroups > 0
                    ? `${outstandingGroups} review group${outstandingGroups === 1 ? '' : 's'} below is not marked reviewed yet. This confirmation applies only to the current published batch and resets if that batch changes.`
                    : 'This confirmation applies only to the current published batch and resets if that batch changes.'
                }
              />
              <details className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] px-3 py-2">
                <summary className="adm-focusable cursor-pointer rounded text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text-muted)]">
                  Technical release details
                </summary>
                <dl className="mt-2 grid gap-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)] sm:grid-cols-2">
                  <div>
                    <dt>Confirmed live commit</dt>
                    <dd>
                      <code>{shortDiagnosticCommit(overview.deploy.live_commit) ?? 'Not confirmed'}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Latest production build commit</dt>
                    <dd>
                      <code>{shortDiagnosticCommit(overview.deploy.latest?.commit) ?? 'Not available'}</code>
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt>Current batch target</dt>
                    <dd>
                      The existing release endpoint resolves the accumulated published exports when the reviewed release
                      starts.
                    </dd>
                  </div>
                </dl>
              </details>
            </div>
          </Card>

          <section aria-label="Release review groups" className="grid gap-4 lg:grid-cols-2">
            {reviewGroups.length ? (
              reviewGroups.map((group) => (
                <ReleaseReviewGroupCard
                  key={group.category}
                  group={group}
                  acknowledged={acknowledgedCategories.includes(group.category)}
                  onAcknowledge={acknowledgeGroup}
                />
              ))
            ) : (
              <Card>
                <h2 className="font-semibold text-[var(--adm-text-heading)]">Published changes ready to release</h2>
                <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                  Everything published is already live.
                </p>
              </Card>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="font-semibold text-[var(--adm-text-heading)]">Pending approvals</h2>
                <Badge tone={approvals.length ? 'warning' : 'neutral'}>{approvals.length}</Badge>
              </div>
              <ApprovalDecisionList
                items={approvals}
                empty="No object is waiting for an approval decision."
                canForceRelease={canForceRelease}
                onDecide={decideApproval}
                onForceRelease={setForceTarget}
              />
            </Card>
            <Card>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="font-semibold text-[var(--adm-text-heading)]">Needs you</h2>
                <Badge tone={work.needsYouCount ? 'warning' : 'neutral'}>{work.needsYouCount}</Badge>
              </div>
              <WorkList chats={work.needsYouChats} empty="No agent work needs a decision." />
              {/* D3: the same objects, so the same decision controls — a
                  needs-you list that only links out is exactly the text-only
                  approval this task exists to delete. */}
              <ApprovalDecisionList
                items={approvals.filter(
                  (approval) => !work.needsYouChats.some((chat) => chat.object_id === approval.object_id)
                )}
                canForceRelease={canForceRelease}
                onDecide={decideApproval}
                onForceRelease={setForceTarget}
              />
            </Card>
            <Card>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="font-semibold text-[var(--adm-text-heading)]">Working</h2>
                <Badge tone={work.workingCount ? 'info' : 'neutral'}>{work.workingCount}</Badge>
              </div>
              <WorkList chats={work.working} empty="No agent work is running." />
            </Card>
          </div>
        </>
      )}

      {/* T0.3 row A8 — breaking someone else's lock is destructive and
          owner-only, so it confirms through the shared ConfirmDialog rather
          than adding a second confirmation mechanism. */}
      <ConfirmDialog
        open={forceTarget !== null}
        onClose={() => setForceTarget(null)}
        onConfirm={() => forceTarget && void runForceRelease(forceTarget)}
        title="Force-release this edit lock?"
        message={
          forceTarget
            ? `Whoever holds the lock on "${forceTarget.display_name}" — an agent or another editor — loses it immediately and has to check the object out again. Unsaved work in their session is not recovered by this.`
            : undefined
        }
        confirmLabel="Force-release"
        tone="danger"
      />
    </div>
  );
}

export default function ReleaseWorkspace({ identity }: { identity: SiteIdentity }) {
  return (
    <AdminShell currentPath="/admin/release" title="Release" identity={identity}>
      <ReleaseWorkspaceContent />
    </AdminShell>
  );
}
