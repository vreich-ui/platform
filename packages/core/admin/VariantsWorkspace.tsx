/**
 * T4.4 — `/admin/variants`: article variant families, their judged evidence,
 * and one-click winner selection.
 *
 * ## What this screen is, and what it deliberately is not
 *
 * It is NOT an A/B testing monitor, and none of its copy says it is. The
 * substrate for one is half-built: `object_create_variant` gives real variants,
 * but nothing splits traffic between them and no per-variant reader numbers
 * reach this app. Both facts are stated on the screen with the file that proves
 * them (`EVIDENCE_GAPS` in `@core/lib/admin/variant-experiments`), because a
 * results panel that quietly shows nothing teaches an editor less than one that
 * says exactly what is missing. 12-plan section 15.4 is explicit about this:
 * "the design refuses any UI/tooling copy that calls them A/B tests."
 *
 * Consequently there is NO split control (it would change nothing), NO chart
 * (there is no series to draw), and NO significance figure (there is no sample
 * to compute one over). What there IS: the family graph, the D4 status of every
 * member, the agent judge scores that genuinely live on the records, variant
 * creation through the verb's own dry run, and a winner selection composed from
 * checkout/publish/retire.
 *
 * Styling: Tailwind + `--adm-*` tokens only; every status colour comes from
 * D4 (`StatusBadge`, `SeverityIcon`), no hex, no new dependency.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminShell } from './AdminShell';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { Select } from './forms';
import { ConfirmDialog, Popover, useToast, type PopoverTriggerA11yProps } from './overlays';
import { StatusBadge, SeverityIcon } from './severity';
import { IconArchive, IconInfo, IconLayoutGrid, IconRocket } from './icons';
import type { SiteIdentity } from '@core/lib/site-identity';
import {
  buildVariantFamilies,
  variantEvidence,
  type VariantFamily,
  type VariantMember,
  type VariantMemberView,
} from '@core/lib/admin/variant-experiments';
import {
  planWinnerSelection,
  selectWinner,
  type WinnerPlan,
  type WinnerSelectionOutcome,
} from '@core/lib/admin/variant-winner';
import {
  createVariant,
  fetchVariantMembers,
  previewVariant,
  type VariantPreview,
} from '@core/lib/admin/variants-client';

async function getToken(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

const objectHref = (objectId: string) => `/admin/content/${objectId}`;

// ─── member row ─────────────────────────────────────────────────────────────

function MemberRow({
  view,
  selected,
  onSelect,
  disabledReason,
  groupName,
}: {
  view: VariantMemberView;
  selected: boolean;
  onSelect: () => void;
  disabledReason?: string;
  /** T6.1: must be the SAME string for every member of one family so the
   * browser (and a screen reader's "radio N of M" announcement, and native
   * arrow-key roving) treats the family's rows as one radio group — this
   * used to be per-member (`member.object_id`), which made every radio its
   * own isolated group of one. */
  groupName: string;
}) {
  const { member } = view;
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-[var(--adm-border)] px-4 py-3 first:border-t-0">
      {disabledReason ? (
        <Popover
          mode="hover"
          content={disabledReason}
          disabled
          trigger={(a11y) => (
            <input
              type="radio"
              name={groupName}
              checked={selected}
              onChange={onSelect}
              disabled
              aria-label={`Choose ${member.display_name} as the winner`}
              className="adm-focusable h-4 w-4 accent-[var(--adm-accent)]"
              {...a11y}
            />
          )}
        />
      ) : (
        <input
          type="radio"
          name={groupName}
          checked={selected}
          onChange={onSelect}
          aria-label={`Choose ${member.display_name} as the winner`}
          className="adm-focusable h-4 w-4 accent-[var(--adm-accent)]"
        />
      )}
      <div className="min-w-0 flex-1">
        <a
          href={objectHref(member.object_id)}
          className="adm-focusable block truncate text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-heading)] hover:underline"
        >
          {member.display_name}
        </a>
        <p className="truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {member.slug ? `/${member.slug} · ` : ''}
          {member.object_id}
        </p>
      </div>
      <Badge tone="neutral">{view.role === 'parent' ? 'Source' : 'Variant'}</Badge>
      <StatusBadge level={view.severity}>{view.statusLabel}</StatusBadge>
      {member.lock?.held ? (
        <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Locked by {member.lock.owner_label ?? 'someone else'}
        </span>
      ) : null}
    </li>
  );
}

// ─── evidence panel ─────────────────────────────────────────────────────────

function EvidencePanel({ family }: { family: VariantFamily }) {
  const evidence = variantEvidence(family);
  const columns = family.members;

  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-2 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        <SeverityIcon level="info" size={14} title="" className="mt-0.5 shrink-0" />
        <span>{evidence.headline}</span>
      </p>

      {evidence.rows.length > 0 ? (
        <div className="overflow-x-auto rounded-[var(--adm-radius-md)] border border-[var(--adm-border)]">
          <table className="w-full min-w-[32rem] border-collapse text-[length:var(--adm-text-sm)]">
            <thead>
              <tr className="bg-[var(--adm-surface-sunken)] text-left">
                <th scope="col" className="px-3 py-2 font-medium text-[var(--adm-text-muted)]">
                  Judged dimension
                </th>
                {columns.map((view) => (
                  <th
                    key={view.member.object_id}
                    scope="col"
                    className="px-3 py-2 font-medium text-[var(--adm-text-muted)]"
                  >
                    {view.member.display_name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {evidence.rows.map((row) => (
                <tr key={`${row.framework} ${row.dimension}`} className="border-t border-[var(--adm-border)]">
                  <th scope="row" className="px-3 py-2 text-left font-normal text-[var(--adm-text)]">
                    {row.dimension}
                    <span className="ml-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                      {row.framework}
                    </span>
                  </th>
                  {columns.map((view) => {
                    const cell = row.cells.find((candidate) => candidate.objectId === view.member.object_id);
                    return (
                      <td key={view.member.object_id} className="px-3 py-2 text-[var(--adm-text)]">
                        {cell ? (
                          <span title={`${cell.scoredBy} · ${cell.at}${cell.rationale ? ` · ${cell.rationale}` : ''}`}>
                            {cell.score}
                            <span className="ml-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                              {cell.metric ? 'metric' : cell.scoredBy}
                            </span>
                          </span>
                        ) : (
                          <span className="text-[var(--adm-text-muted)]">not judged</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="rounded-[var(--adm-radius-md)] border border-dashed border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] p-4">
        <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-heading)]">
          No reader results are shown here, because three things do not exist yet
        </p>
        <ul className="mt-3 flex flex-col gap-3">
          {evidence.gaps.map((gap) => (
            <li key={gap.id}>
              <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{gap.title}</p>
              <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{gap.detail}</p>
              <p className="mt-0.5 break-words font-mono text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                {gap.source}
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-[var(--adm-border)] pt-3 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {evidence.significanceNote}
        </p>
      </div>
    </div>
  );
}

// ─── family card ────────────────────────────────────────────────────────────

function FamilyCard({
  family,
  onSelectWinner,
  busy,
}: {
  family: VariantFamily;
  onSelectWinner: (plan: WinnerPlan) => void;
  busy: boolean;
}) {
  const selectable = family.members.filter((view) => view.member.status === 'active');
  const [winnerId, setWinnerId] = useState<string>(() => selectable[0]?.member.object_id ?? '');
  const plan = useMemo(() => (winnerId ? planWinnerSelection(family, winnerId) : undefined), [family, winnerId]);

  return (
    <Card
      kicker={family.parentMissing ? 'Source article retired' : 'Variant family'}
      title={family.parent?.member.display_name ?? family.parentId}
      actions={<StatusBadge level={family.stageSeverity}>{family.stageLabel}</StatusBadge>}
      bodyClassName="flex flex-col gap-5"
    >
      <ul className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)]">
        {family.members.map((view) => (
          <MemberRow
            key={view.member.object_id}
            view={view}
            selected={view.member.object_id === winnerId}
            onSelect={() => setWinnerId(view.member.object_id)}
            groupName={`winner-${family.parentId}`}
            disabledReason={
              view.member.status === 'archived'
                ? 'This article is archived. The object store has no unarchive verb, so it cannot be promoted from here.'
                : undefined
            }
          />
        ))}
      </ul>

      <EvidencePanel family={family} />

      {plan ? (
        <div className="flex flex-col gap-2">
          {plan.blockers.map((blocker) => (
            <p
              key={`${blocker.code}-${blocker.objectId ?? ''}`}
              className="flex items-start gap-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]"
            >
              <SeverityIcon
                level={blocker.code === 'nothing_to_do' ? 'info' : 'blocked'}
                size={14}
                title=""
                className="mt-0.5 shrink-0"
              />
              <span>{blocker.message}</span>
            </p>
          ))}
          {plan.untouched.length > 0 ? (
            <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {plan.untouched.map((view) => view.member.display_name).join(', ')} stays a draft. {plan.untouchedReason}
            </p>
          ) : null}
          <div>
            {(() => {
              const winnerDisabled = !plan.runnable || busy;
              const blockedReason = plan.runnable ? undefined : plan.blockers[0]?.message;
              const winnerButton = (a11y?: PopoverTriggerA11yProps) => (
                <Button variant="primary" disabled={winnerDisabled} onClick={() => onSelectWinner(plan)} {...a11y}>
                  <IconRocket size={16} /> Select winner
                </Button>
              );
              // Convention D3: disabled with a reason needs a reachable
              // tooltip, not a native `title` — a transiently busy-disabled
              // button needs no tooltip of its own.
              return winnerDisabled && blockedReason ? (
                <Popover mode="hover" content={blockedReason} disabled trigger={(a11y) => winnerButton(a11y)} />
              ) : (
                winnerButton()
              );
            })()}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

// ─── the page ───────────────────────────────────────────────────────────────

/**
 * The body is a CHILD of `AdminShell` on purpose: `AdminShell` mounts the
 * `ToastProvider` around its children (T9.3), so a `useToast()` in the
 * component that RENDERS the shell would resolve outside that provider and
 * throw. `KitGallery.tsx` splits itself the same way for the same reason.
 */
function VariantsBody() {
  const [members, setMembers] = useState<VariantMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<WinnerPlan>();
  const [outcome, setOutcome] = useState<WinnerSelectionOutcome>();
  const [sourceId, setSourceId] = useState('');
  const [preview, setPreview] = useState<(VariantPreview & { sourceId: string }) | undefined>();
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setMembers(await fetchVariantMembers(getToken));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Article variants could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const families = useMemo(() => buildVariantFamilies(members), [members]);
  const sourceOptions = useMemo(
    () =>
      members
        .filter((member) => member.status === 'active')
        .map((member) => ({ value: member.object_id, label: member.display_name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [members]
  );

  const runPreview = async () => {
    if (!sourceId) return;
    setBusy(true);
    try {
      const result = await previewVariant(getToken, sourceId);
      if (!result.ok)
        toast({
          tone: 'danger',
          title: 'The variant could not be built',
          ...(result.error ? { description: result.error } : {}),
        });
      else setPreview({ ...result, sourceId });
    } finally {
      setBusy(false);
    }
  };

  const confirmCreate = async () => {
    if (!preview) return;
    const source = preview.sourceId;
    setPreview(undefined);
    setBusy(true);
    try {
      const result = await createVariant(getToken, source);
      if (!result.ok) {
        toast({
          tone: 'danger',
          title: 'The variant was not created',
          ...(result.error ? { description: result.error } : {}),
        });
        return;
      }
      toast({
        tone: 'success',
        title: 'Variant drafted',
        description: `${result.objectId ?? 'The clone'} is a draft. It publishes nothing until you select it as the winner.`,
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const confirmWinner = async () => {
    const plan = pendingPlan;
    setPendingPlan(undefined);
    if (!plan) return;
    setBusy(true);
    try {
      const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
      const result = await selectWinner(getToken, plan, { callVerb: callObjectVerb });
      setOutcome(result);
      toast({
        tone: result.ok ? 'success' : 'danger',
        title: result.ok ? 'Winner selected' : 'The selection did not finish',
        description: result.receipt,
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="max-w-2xl">
        <h1 className="text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]">
          Article variants
        </h1>
        <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Cloned articles, what has been judged about them, and which one you want live. This is not an A/B test:
          nothing splits traffic between a source and its variant, so the two are read one after the other, never side
          by side.
        </p>
      </header>

      <Card kicker="Variant management" title="Draft a variant" bodyClassName="flex flex-col gap-3">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Cloning re-mints the node ids, carries the claims and compliance annotations across, clears the judge scores,
          and gives the clone its own slug. The clone lands as a draft — it publishes nothing.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Source article"
            options={sourceOptions}
            placeholder="Choose an article"
            value={sourceId}
            onChange={(event) => setSourceId(event.currentTarget.value)}
          />
          <Button variant="secondary" disabled={!sourceId || busy} onClick={() => void runPreview()}>
            <IconLayoutGrid size={16} /> Preview the clone
          </Button>
        </div>
      </Card>

      {outcome && !outcome.ok && outcome.state === 'promoted_not_archived' ? (
        <div className="flex items-start gap-3 rounded-[var(--adm-radius-md)] border border-[var(--adm-danger)] bg-[var(--adm-danger-soft)] p-4">
          <SeverityIcon level="error" size={18} title="Half-applied" className="mt-0.5 shrink-0" />
          <div>
            <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-danger-text)]">
              The promotion landed, the archive did not
            </p>
            <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
              {outcome.recovery?.message ?? outcome.receipt}
            </p>
            {outcome.error ? (
              <p className="mt-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                The server said: {outcome.error}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {outcome?.ok && outcome.warnings.length > 0 ? (
        <p className="flex items-start gap-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          <IconArchive size={14} className="mt-0.5 shrink-0" />
          <span>{outcome.warnings.join(' ')}</span>
        </p>
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-3" role="status" aria-live="polite">
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">Reading article records…</p>
          <Skeleton variant="rect" height={280} />
        </div>
      ) : error ? (
        <EmptyState
          severity="error"
          title="Variants unavailable"
          message={`${error} No article has been changed.`}
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : families.length === 0 ? (
        <EmptyState
          icon={<IconInfo size={26} />}
          title="No variant families yet"
          message="A family appears as soon as an article is cloned — the clone carries the source's id in its lineage, and that link is what this page walks. Draft one above, or ask the agent to."
        />
      ) : (
        <div className="flex flex-col gap-5">
          {families.map((family) => (
            <FamilyCard key={family.parentId} family={family} busy={busy} onSelectWinner={setPendingPlan} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(preview)}
        onClose={() => setPreview(undefined)}
        onConfirm={() => void confirmCreate()}
        title="Create this variant?"
        confirmLabel="Create the draft"
        message={
          preview ? (
            <>
              The clone would be <span className="font-mono">{preview.objectId ?? 'a newly minted id'}</span> at{' '}
              <span className="font-mono">/{preview.slug ?? 'a generated slug'}</span>.{' '}
              {preview.idAvailable === false ? 'That id is already taken, so creating it will fail. ' : ''}
              It lands as a draft and publishes nothing. Nothing has been written yet — this preview is the verb&apos;s
              own dry run.
            </>
          ) : undefined
        }
      />

      <ConfirmDialog
        open={Boolean(pendingPlan)}
        onClose={() => setPendingPlan(undefined)}
        onConfirm={() => void confirmWinner()}
        tone="danger"
        title="Select this winner?"
        confirmLabel="Publish and archive"
        message={
          pendingPlan ? (
            <>
              <span className="block">
                {pendingPlan.winner.member.display_name} will be published, then{' '}
                {pendingPlan.losers.length === 0
                  ? 'nothing else changes'
                  : `${pendingPlan.losers.map((loser) => loser.member.display_name).join(', ')} will be archived and ${pendingPlan.losers.length === 1 ? 'its export' : 'their exports'} removed`}
                . Both changes go live on the next release.
              </span>
              <span className="mt-2 block">
                An archived article keeps its record and its history, but retire writes a redirect only for pages — an
                archived article&apos;s permalink simply stops resolving, and there is no unarchive verb to put it back.
              </span>
              <span className="mt-2 block">
                If the archive step fails after the publish lands, both stay live and this screen says so; running it
                again resumes at the archive step instead of repeating the publish.
              </span>
              <span className="mt-2 block font-mono text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                {pendingPlan.steps.map((step) => step.verb).join(' → ')}
              </span>
              <span className="mt-2 block text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                Cancel leaves every article exactly as it is.
              </span>
            </>
          ) : undefined
        }
      />
    </div>
  );
}

export default function VariantsWorkspace({ identity }: { identity: SiteIdentity }) {
  return (
    <AdminShell currentPath="/admin/variants" title="Variants" identity={identity} wide>
      <VariantsBody />
    </AdminShell>
  );
}
