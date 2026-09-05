/**
 * Visual identity → Imagery tab (U1, brand-imagery wave).
 *
 * A THIN RENDERER, on purpose. Platform admin tests are logic-first
 * `node:test` over `packages/core/lib/admin/*.ts`, and `tsconfig.test.json`
 * excludes every `packages/core/admin/*.tsx` — so a decision made in this file
 * is a decision nothing tests. Every view model, bound, normalization, op
 * payload and chat intent therefore lives in
 * `@core/lib/admin/visual-identity-imagery`; this file owns markup, hooks and
 * I/O and nothing else.
 *
 * HOOK ORDER. Every hook in every component here sits above every conditional
 * return, and the mood board is remounted by `key` when the selected standard
 * changes rather than synced with an effect — a hook behind a branch is the
 * exact crash this repo's `.tsx`-blind suite cannot catch.
 *
 * WHAT WRITES, AND HOW. Two different paths, deliberately:
 *
 *  - Everything with an EXISTING browser-reachable verb goes straight to
 *    `admin-object`: the mood board writes `set_visual_standard_fields` under
 *    a normal checkout, "Make this the site's imagery" runs the
 *    `apply_brand_imagery` verb (dry run → diff card → confirm under a site
 *    checkout), and "New template" is an ordinary `create`. No endpoint was
 *    added for any of it.
 *  - Importing references is its OWN admin endpoint since A1:
 *    `admin-visual-identity-import` mints the request id, calls the same
 *    `import_images_from_url` server handler the MCP tool uses, mirrors the
 *    bytes into this site's artifact store so the cards can render, and
 *    appends `ref_` entries under a real checkout. The browser sends
 *    addresses only — never an id — one address per call so the human sees
 *    per-address progress.
 *  - Proposing a contract from the mood board is its OWN admin endpoint
 *    since A3: `admin-visual-identity-propose` resolves the SELECTED
 *    standard's own references to base64 server-side (never a URL the
 *    CMS-Agent node runner would have to fetch and 401 on) and calls
 *    `visual_identity_propose` directly. The button only reaches `onIntent`
 *    (the U3 chat-rail seam) for the "no standard yet" empty state, where
 *    there is no standard id yet to propose against.
 */
import { useCallback, useMemo, useRef, useState } from 'react';

import { ArtifactStagePreview } from './ArtifactStagePreview';
import { Badge, Button, Card, EmptyState } from './primitives';
import { Input, Textarea } from './forms';
import { Dialog } from './overlays';
import { IconAlertTriangle, IconLock, IconPlus, IconSparkles } from './icons';
import type { SiteIdentity } from '@core/lib/site-identity';
import type { EditorialArtifact } from '@core/lib/admin/editorial-assets';
import { fetchEditorialAssets } from '@core/lib/admin/editorial-assets-client';
import { importVisualReferencesInOrder, type ImportProgressRow } from '@core/lib/admin/visual-identity-import-client';
import {
  proposeVisualIdentityContract,
  referencesReachedWriterLabel,
  type ProposeContractResponse,
} from '@core/lib/admin/visual-identity-propose-client';
import type { StudioRecord } from '@core/lib/admin/studio-client';
import { EditSession, callObjectVerb, type GetToken } from '@core/lib/edit-mode/verbs-client';
import {
  MOOD_BOARD_MAX_REFERENCES,
  REFERENCE_WEIGHT_MAX,
  REFERENCE_WEIGHT_MIN,
  REFERENCE_WEIGHT_STEP,
  appendLibraryReference,
  blobKeyFromPreviewUrl,
  buildApplyImageryVerb,
  buildImageryDiff,
  buildImageryWorkspace,
  buildNewTemplateDraft,
  buildProposeContractIntent,
  buildReferencesOp,
  buildRegenerateExamplesIntent,
  clampReferenceWeight,
  exampleArtifact,
  moodBoardArtifact,
  parseImportUrls,
  referenceWeightLabel,
  regionFromDrag,
  regionScopeLabel,
  type BrandImageryOverridePolicy,
  type ImageryContractView,
  type ImageryDiffModel,
  type MoodBoardReferenceView,
  type VisualIdentityChatIntent,
  type VisualStandardExampleView,
  type VisualStandardView,
} from '@core/lib/admin/visual-identity-imagery';

const MUTED = 'text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]';
const IMPORT_STATE_LABEL: Record<ImportProgressRow['state'], string> = {
  waiting: 'Queued',
  importing: 'Importing…',
  added: 'Added',
  duplicate: 'Already on the board',
  failed: 'Failed',
};

const IMPORT_STATE_CLASS: Record<ImportProgressRow['state'], string> = {
  waiting: 'text-[var(--adm-text-muted)]',
  importing: 'text-[var(--adm-text)]',
  added: 'font-semibold text-[var(--adm-text-heading)]',
  duplicate: 'text-[var(--adm-text-muted)]',
  failed: 'font-semibold text-[var(--adm-warning-text)]',
};

const XS_LABEL = 'text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]';

// ─── the applied / standard contract card ───────────────────────────────────

function ContractBody({ contract }: { contract: ImageryContractView }) {
  if (!contract.present) {
    return (
      <EmptyState
        title="No imagery contract"
        message="Nothing declares how this publication's images should look yet."
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {contract.styleSentence ? (
        <p className="text-[length:var(--adm-text-base)] text-[var(--adm-text-heading)]">{contract.styleSentence}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {contract.mediumLabel ? <Badge tone="accent">{contract.mediumLabel}</Badge> : null}
        {contract.seedBase !== undefined ? <Badge tone="neutral">seed base {contract.seedBase}</Badge> : null}
        {contract.lora ? <Badge tone="info">LoRA {contract.lora.version ?? 'configured'}</Badge> : null}
      </div>

      <div>
        <p className={XS_LABEL}>Palette</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {contract.palette.length ? (
            contract.palette.map((color) => (
              <span
                key={color}
                className="inline-flex items-center gap-2 rounded-[var(--adm-radius-pill)] border border-[var(--adm-border)] py-1 pl-1 pr-3"
              >
                <span
                  className="h-5 w-5 rounded-full border border-black/10"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
                <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text)]">{color}</span>
              </span>
            ))
          ) : (
            <span className={MUTED}>No swatches declared.</span>
          )}
        </div>
      </div>

      <div>
        <p className={XS_LABEL}>Never show</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {contract.negatives.length ? (
            contract.negatives.map((entry) => (
              <Badge key={entry} tone="danger">
                {entry}
              </Badge>
            ))
          ) : (
            <span className={MUTED}>Nothing is excluded.</span>
          )}
        </div>
      </div>

      <div>
        <p className={XS_LABEL}>Aspect ratios</p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[18rem] text-left text-[length:var(--adm-text-sm)]">
            <thead>
              <tr className="text-[length:var(--adm-text-xs)] uppercase tracking-wide text-[var(--adm-text-muted)]">
                <th scope="col" className="py-1 pr-4 font-medium">
                  Usage context
                </th>
                <th scope="col" className="py-1 font-medium">
                  Ratio
                </th>
              </tr>
            </thead>
            <tbody>
              {contract.aspectRatios.length ? (
                contract.aspectRatios.map((row) => (
                  <tr key={row.context} className="border-t border-[var(--adm-border)]">
                    <td className="py-1.5 pr-4 text-[var(--adm-text)]">{row.contextLabel}</td>
                    <td className="py-1.5 font-mono text-[var(--adm-text)]">{row.ratio}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2} className={`py-1.5 ${MUTED}`}>
                    No per-context ratios declared.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {contract.composition.length ? (
        <div>
          <p className={XS_LABEL}>Composition</p>
          <ul className="mt-2 flex flex-col gap-1">
            {contract.composition.map((row) => (
              <li key={row.label} className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
                <span className="text-[var(--adm-text-muted)]">{row.label}: </span>
                {row.value}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ─── the before/after diff card ─────────────────────────────────────────────

function DiffCard({ diff, title, note }: { diff: ImageryDiffModel; title: string; note?: string }) {
  return (
    <Card kicker="Before → after" title={title}>
      <div className="flex flex-col gap-3">
        {note ? <p className={MUTED}>{note}</p> : null}
        {!diff.changed ? (
          <p className={MUTED}>Nothing changes — the site already carries exactly this contract.</p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-[length:var(--adm-text-sm)]">
            <thead>
              <tr className="text-[length:var(--adm-text-xs)] uppercase tracking-wide text-[var(--adm-text-muted)]">
                <th scope="col" className="py-1 pr-4 font-medium">
                  Field
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  {diff.hasBefore ? 'Now' : 'Now (none)'}
                </th>
                <th scope="col" className="py-1 font-medium">
                  After
                </th>
              </tr>
            </thead>
            <tbody>
              {diff.rows.map((row) => (
                <tr
                  key={row.field}
                  className={`border-t border-[var(--adm-border)] ${row.changed ? 'bg-[var(--adm-warning-soft)]' : ''}`}
                >
                  <th scope="row" className="py-1.5 pr-4 text-left font-medium text-[var(--adm-text)]">
                    {row.label}
                    {row.changed ? (
                      <Badge tone="warning" className="ml-2">
                        changed
                      </Badge>
                    ) : null}
                  </th>
                  <td className="py-1.5 pr-4 align-top text-[var(--adm-text-muted)]">{row.before}</td>
                  <td className="py-1.5 align-top text-[var(--adm-text)]">{row.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

// ─── examples strip (X1, R9 — server-generated, this file only renders) ────

function ExamplesStrip({ items }: { items: readonly VisualStandardExampleView[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {items.map((example) => {
        const artifact = exampleArtifact(example);
        return (
          <div key={example.usageContext} className="flex w-40 flex-col gap-1.5">
            <div className="overflow-hidden rounded-[var(--adm-radius-md)] border border-[var(--adm-border)]">
              {artifact ? (
                <ArtifactStagePreview artifact={artifact} size="thumbnail" />
              ) : (
                <EmptyState
                  title="No preview"
                  message={example.previewUnavailableReason ?? 'This image cannot be previewed in the admin.'}
                />
              )}
            </div>
            <span className={XS_LABEL}>{example.usageContextLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── region picker ──────────────────────────────────────────────────────────

/**
 * The drag rectangle. All arithmetic is `regionFromDrag`'s; this owns the
 * pointer listeners and one DOM measurement — the rendered `<img>` box inside
 * `ArtifactStagePreview`, not the wrapper, so a letterboxed image still maps
 * its fractions to the picture rather than to the padding around it.
 */
function RegionPicker({
  reference,
  onChange,
}: {
  reference: MoodBoardReferenceView;
  onChange: (region: MoodBoardReferenceView['region']) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const originRef = useRef<{ x: number; y: number; box: DOMRect } | null>(null);
  const [drag, setDrag] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const artifact = useMemo(() => moodBoardArtifact(reference), [reference]);

  const imageBox = useCallback((): DOMRect | undefined => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;
    const image = wrapper.querySelector('img');
    return (image ?? wrapper).getBoundingClientRect();
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const box = imageBox();
      if (!box || box.width <= 0 || box.height <= 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      originRef.current = { x: event.clientX - box.left, y: event.clientY - box.top, box };
      setDrag({ left: event.clientX - box.left, top: event.clientY - box.top, width: 0, height: 0 });
    },
    [imageBox]
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const origin = originRef.current;
    if (!origin) return;
    const x = event.clientX - origin.box.left;
    const y = event.clientY - origin.box.top;
    setDrag({
      left: Math.min(origin.x, x),
      top: Math.min(origin.y, y),
      width: Math.abs(x - origin.x),
      height: Math.abs(y - origin.y),
    });
  }, []);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const origin = originRef.current;
      originRef.current = null;
      setDrag(null);
      if (!origin) return;
      onChange(
        regionFromDrag(
          { x: origin.x, y: origin.y },
          { x: event.clientX - origin.box.left, y: event.clientY - origin.box.top },
          { width: origin.box.width, height: origin.box.height }
        )
      );
    },
    [onChange]
  );

  const region = reference.region;

  return (
    <div className="flex flex-col gap-3">
      <p className={MUTED}>
        Drag a rectangle over the image to tell the writer which part matters (“the palette, not the subject”). A drag
        that covers everything, or is too small to be a crop, resets it to the whole image.
      </p>
      <div
        ref={wrapperRef}
        className="relative select-none touch-none rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] p-2"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {artifact ? (
          <ArtifactStagePreview artifact={artifact} />
        ) : (
          <EmptyState
            title="No preview for this reference"
            message={reference.previewUnavailableReason ?? 'This image cannot be previewed in the admin.'}
          />
        )}
        {drag ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute border-2 border-[var(--adm-accent)] bg-[var(--adm-accent-soft)]/40"
            style={{ left: drag.left, top: drag.top, width: drag.width, height: drag.height }}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={region ? 'accent' : 'neutral'}>{regionScopeLabel(region)}</Badge>
        {region ? (
          <span className="font-mono text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            x {region.x} · y {region.y} · w {region.w} · h {region.h}
          </span>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => onChange(undefined)} disabled={!region}>
          Use the whole image
        </Button>
      </div>
    </div>
  );
}

// ─── mood board ─────────────────────────────────────────────────────────────

/**
 * Remounted by `key` whenever the selected standard changes, so its draft
 * state is initialized from props once and never needs a sync effect.
 */
function MoodBoard({
  standard,
  canEdit,
  busy,
  onSave,
}: {
  standard: VisualStandardView;
  canEdit: boolean;
  busy: boolean;
  onSave: (references: MoodBoardReferenceView[]) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<MoodBoardReferenceView[]>(standard.references);
  const [regionFor, setRegionFor] = useState<string | undefined>(undefined);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(standard.references),
    [draft, standard.references]
  );
  const editing = useMemo(() => draft.find((entry) => entry.id === regionFor), [draft, regionFor]);

  const update = useCallback((id: string, patch: Partial<MoodBoardReferenceView>) => {
    setDraft((current) =>
      current.map((entry) => {
        if (entry.id !== id) return entry;
        const next = { ...entry, ...patch };
        const weight = clampReferenceWeight(next.weight);
        return {
          ...next,
          weight,
          weightLabel: referenceWeightLabel(weight),
          scope: next.region ? 'region' : 'whole',
          scopeLabel: regionScopeLabel(next.region),
        };
      })
    );
  }, []);

  const remove = useCallback((id: string) => {
    setDraft((current) => current.filter((entry) => entry.id !== id));
  }, []);

  return (
    <Card
      kicker="Mood board"
      title={`${standard.label} — ${draft.length} of ${MOOD_BOARD_MAX_REFERENCES} references`}
      actions={
        canEdit ? (
          <Button size="sm" onClick={() => void onSave(draft)} disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save mood board'}
          </Button>
        ) : null
      }
    >
      {draft.length === 0 ? (
        <EmptyState
          title="No references yet"
          message="Add reference images, then ask the agent to write a contract from them."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {draft.map((reference) => {
            const artifact = moodBoardArtifact(reference);
            return (
              <div
                key={reference.id}
                className="flex min-w-0 flex-col gap-3 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] p-3"
              >
                <div className="max-h-64 overflow-hidden rounded-[var(--adm-radius-sm)]">
                  {artifact ? (
                    <ArtifactStagePreview artifact={artifact} size="thumbnail" />
                  ) : (
                    <EmptyState
                      title="No preview"
                      message={reference.previewUnavailableReason ?? 'This image cannot be previewed in the admin.'}
                    />
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={reference.region ? 'accent' : 'neutral'}>{reference.scopeLabel}</Badge>
                  <Badge tone="neutral">{referenceWeightLabel(reference.weight)}</Badge>
                </div>

                <label className="flex flex-col gap-1">
                  <span className={XS_LABEL}>Style weight</span>
                  <input
                    type="range"
                    min={REFERENCE_WEIGHT_MIN}
                    max={REFERENCE_WEIGHT_MAX}
                    step={REFERENCE_WEIGHT_STEP}
                    value={reference.weight}
                    disabled={!canEdit}
                    onChange={(event) => update(reference.id, { weight: Number(event.target.value) })}
                    className="adm-focusable w-full"
                    aria-label={`Style weight for ${reference.note ?? reference.id}`}
                  />
                </label>

                <Input
                  label="Note"
                  hint="What this reference is for — the palette, not the subject."
                  maxLength={200}
                  value={reference.note ?? ''}
                  disabled={!canEdit}
                  onChange={(event) => update(reference.id, { note: event.target.value })}
                />

                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setRegionFor(reference.id)} disabled={!canEdit}>
                    {reference.region ? 'Edit region' : 'Set region'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(reference.id)} disabled={!canEdit}>
                    Remove
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={Boolean(editing)}
        onClose={() => setRegionFor(undefined)}
        size="lg"
        title="Region of interest"
        description={editing?.note ?? editing?.blobKey}
        footer={<Button onClick={() => setRegionFor(undefined)}>Done</Button>}
      >
        {editing ? <RegionPicker reference={editing} onChange={(region) => update(editing.id, { region })} /> : null}
      </Dialog>
    </Card>
  );
}

// ─── library picker ─────────────────────────────────────────────────────────

function LibraryPicker({
  open,
  onClose,
  artifacts,
  loading,
  error,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  artifacts: EditorialArtifact[];
  loading: boolean;
  error?: string;
  onPick: (artifact: EditorialArtifact) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Pick from the media library">
      {loading ? <p className={MUTED}>Loading the media library…</p> : null}
      {error ? <EmptyState severity="error" title="Media unavailable" message={error} /> : null}
      {!loading && !error && artifacts.length === 0 ? (
        <EmptyState title="No images in the library" message="Import one by address, or generate one first." />
      ) : null}
      <div className="grid max-h-[55dvh] gap-3 overflow-y-auto sm:grid-cols-3">
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            onClick={() => onPick(artifact)}
            className="adm-focusable flex flex-col gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] p-2 text-left hover:bg-[var(--adm-surface-sunken)]"
          >
            <div className="max-h-40 overflow-hidden rounded-[var(--adm-radius-sm)]">
              <ArtifactStagePreview artifact={artifact} size="thumbnail" />
            </div>
            <span className="truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text)]">{artifact.label}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

// ─── the tab ────────────────────────────────────────────────────────────────

export interface ImageryBoardProps {
  identity: SiteIdentity;
  site: StudioRecord | undefined;
  standards: readonly StudioRecord[];
  overridePolicy: BrandImageryOverridePolicy;
  isOwner: boolean;
  getToken: GetToken;
  /** The U3 seam: hand a tool-backed action to the docked chat rail. */
  onIntent: (intent: VisualIdentityChatIntent) => void;
  /** Reload the records this tab reads after a successful write. */
  onChanged: () => void | Promise<void>;
}

export function ImageryBoard({
  identity,
  site,
  standards,
  overridePolicy,
  isOwner,
  getToken,
  onIntent,
  onChanged,
}: ImageryBoardProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [applyDiff, setApplyDiff] = useState<{ standardId: string; diff: ImageryDiffModel } | undefined>(undefined);
  const [importText, setImportText] = useState('');
  const [importNote, setImportNote] = useState('');
  const [importProgress, setImportProgress] = useState<ImportProgressRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [brief, setBrief] = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposeResult, setProposeResult] = useState<
    { standardId: string; response: ProposeContractResponse } | undefined
  >(undefined);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<EditorialArtifact[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | undefined>(undefined);
  const [newTemplateOpen, setNewTemplateOpen] = useState(false);
  const [newTemplateLabel, setNewTemplateLabel] = useState('');
  const [newTemplateWhenToUse, setNewTemplateWhenToUse] = useState('');

  const model = useMemo(
    () =>
      buildImageryWorkspace({
        site,
        standards,
        overridePolicy,
        isOwner,
        isAdmin: true,
        ...(selectedId ? { selectedStandardId: selectedId } : {}),
        siteShortId: identity.siteShortId,
      }),
    [site, standards, overridePolicy, isOwner, selectedId, identity.siteShortId]
  );

  const selected = model.selected;
  const importPreview = useMemo(() => parseImportUrls(importText), [importText]);
  /** The selected standard's RAW brandImagery — what a clone copies verbatim. */
  const selectedImagery = useMemo(() => {
    const record = standards.find((entry) => entry.object_id === selected?.objectId);
    return (record?.body as Record<string, unknown> | undefined)?.brandImagery;
  }, [selected?.objectId, standards]);

  const saveReferences = useCallback(
    async (references: MoodBoardReferenceView[]) => {
      if (!selected) return;
      setBusy(true);
      setError(undefined);
      setNotice(undefined);
      const session = new EditSession('visual_standard', selected.objectId, getToken);
      try {
        const checkout = await session.ensureCheckout();
        if (!checkout.ok) {
          setError(`The standard is checked out by ${checkout.heldBy ?? 'someone else'}.`);
          return;
        }
        const result = await session.patch([buildReferencesOp(references)]);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setNotice('Mood board saved.');
        await onChanged();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'The mood board could not be saved.');
      } finally {
        await session.checkin().catch(() => undefined);
        setBusy(false);
      }
    },
    [getToken, onChanged, selected]
  );

  const openLibrary = useCallback(async () => {
    setLibraryOpen(true);
    setLibraryLoading(true);
    setLibraryError(undefined);
    try {
      const assets = await fetchEditorialAssets(getToken);
      setLibrary(assets.artifacts.filter((artifact) => artifact.kind === 'image'));
    } catch (reason) {
      setLibraryError(reason instanceof Error ? reason.message : 'The media library could not be loaded.');
    } finally {
      setLibraryLoading(false);
    }
  }, [getToken]);

  const pickFromLibrary = useCallback(
    async (artifact: EditorialArtifact) => {
      if (!selected) return;
      const blobKey = blobKeyFromPreviewUrl(artifact.preview_url);
      if (!blobKey) {
        setLibraryError('That image has no usable storage key.');
        return;
      }
      const next = appendLibraryReference(selected.references, { blobKey, note: artifact.label });
      if (!next.ok) {
        setLibraryError(next.error);
        return;
      }
      setLibraryOpen(false);
      await saveReferences(next.references);
    },
    [saveReferences, selected]
  );

  /**
   * A3: proposing runs against `admin-visual-identity-propose` directly —
   * the endpoint resolves THIS standard's own mood board to base64
   * server-side (crop/region applied via sharp) and calls
   * `visual_identity_propose` itself, so the browser sends only the
   * standard id and the brief. Nothing here writes the standard; a proposal
   * is read-only until "Make this the site's imagery" applies it.
   */
  const runPropose = useCallback(async () => {
    if (!selected) return;
    setProposing(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await proposeVisualIdentityContract(getToken, { standardId: selected.objectId, brief });
      setProposeResult({ standardId: selected.objectId, response });
      setNotice(referencesReachedWriterLabel(response));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The contract could not be proposed.');
    } finally {
      setProposing(false);
    }
  }, [brief, getToken, selected]);

  /**
   * A1: the import runs against `admin-visual-identity-import`, one address
   * at a time so each row reports for itself. The endpoint owns the whole
   * write — request id, pdf-tool call, byte mirror, `ref_` ids and the
   * `set_visual_standard_fields` append — so there is nothing to save here
   * afterwards beyond reloading what the tab reads.
   */
  const runImport = useCallback(async () => {
    if (!selected || importPreview.urls.length === 0) return;
    setImporting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const outcome = await importVisualReferencesInOrder(
        getToken,
        {
          standardId: selected.objectId,
          urls: importPreview.urls,
          ...(importNote.trim() ? { note: importNote.trim() } : {}),
        },
        setImportProgress
      );
      const failed = outcome.rows.filter((row) => row.state === 'failed');
      if (outcome.added.length > 0) {
        setImportText('');
        setNotice(
          `Imported ${outcome.added.length} reference${outcome.added.length === 1 ? '' : 's'} onto the mood board.`
        );
        await onChanged();
      }
      if (failed.length > 0) {
        setError(failed[0]?.error ?? 'Some addresses could not be imported.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The references could not be imported.');
    } finally {
      setImporting(false);
    }
  }, [getToken, importNote, importPreview.urls, onChanged, selected]);

  const previewApply = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await callObjectVerb(
        getToken,
        buildApplyImageryVerb({ siteId: identity.siteId, visualStandardId: selected.objectId, dryRun: true })
      );
      if (result.status !== 200) {
        setError(String(result.body.error ?? `The preview failed (${result.status}).`));
        return;
      }
      setApplyDiff({ standardId: selected.objectId, diff: buildImageryDiff(result.body.before, result.body.after) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The apply preview could not be produced.');
    } finally {
      setBusy(false);
    }
  }, [getToken, identity.siteId, selected]);

  const confirmApply = useCallback(async () => {
    if (!applyDiff) return;
    setBusy(true);
    setError(undefined);
    let lockToken: string | undefined;
    try {
      const checkout = await callObjectVerb(getToken, {
        action: 'checkout',
        object_type: 'site',
        object_id: identity.siteId,
      });
      if (checkout.status !== 200 || typeof checkout.body.lockToken !== 'string') {
        setError(String(checkout.body.error ?? 'The publication is checked out by someone else.'));
        return;
      }
      lockToken = checkout.body.lockToken;
      const result = await callObjectVerb(
        getToken,
        buildApplyImageryVerb({
          siteId: identity.siteId,
          visualStandardId: applyDiff.standardId,
          lockToken,
          expectedRecordVersion: Number(checkout.body.record_version),
        })
      );
      if (result.status !== 200) {
        setError(String(result.body.error ?? `The apply failed (${result.status}).`));
        return;
      }
      setApplyDiff(undefined);
      setNotice("This standard is now the publication's imagery. Publish the site to take it live.");
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The imagery could not be applied.');
    } finally {
      if (lockToken) {
        await callObjectVerb(getToken, {
          action: 'checkin',
          object_type: 'site',
          object_id: identity.siteId,
          lock_token: lockToken,
        }).catch(() => undefined);
      }
      setBusy(false);
    }
  }, [applyDiff, getToken, identity.siteId, onChanged]);

  const createTemplate = useCallback(async () => {
    const draft = buildNewTemplateDraft({
      siteShortId: identity.siteShortId,
      label: newTemplateLabel,
      source: selected,
      sourceBrandImagery: selectedImagery,
      whenToUse: newTemplateWhenToUse,
    });
    if (!draft.ok) {
      setError(draft.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await callObjectVerb(getToken, {
        action: 'create',
        object_type: 'visual_standard',
        // `create` takes `site` + `requested_id` (object-verbs.ts), not
        // `object_id` — the id is REQUESTED and validated against the type's
        // grammar server-side, exactly like the seed scripts and object_create.
        site: identity.siteId,
        requested_id: draft.draft.objectId,
        body: draft.draft.body,
      });
      if (result.status !== 200 && result.status !== 201) {
        setError(String(result.body.error ?? `The template could not be created (${result.status}).`));
        return;
      }
      setNewTemplateOpen(false);
      setNewTemplateLabel('');
      setNewTemplateWhenToUse('');
      setSelectedId(draft.draft.objectId);
      setNotice(`Template ${draft.draft.objectId} created as a draft.`);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The template could not be created.');
    } finally {
      setBusy(false);
    }
  }, [
    getToken,
    identity.siteId,
    identity.siteShortId,
    newTemplateLabel,
    newTemplateWhenToUse,
    onChanged,
    selected,
    selectedImagery,
  ]);

  return (
    <div className="flex flex-col gap-5">
      {error ? <EmptyState severity="error" title="That did not go through" message={error} /> : null}
      {notice ? (
        <p className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-success-soft)] px-3 py-2 text-[length:var(--adm-text-sm)] text-[var(--adm-success-text)]">
          {notice}
        </p>
      ) : null}

      {model.locked ? (
        <div className="flex items-start gap-3 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] bg-[var(--adm-warning-soft)] px-3 py-2">
          <IconLock size={16} />
          <div>
            <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-warning-text)]">
              Per-run imagery override is locked
            </p>
            <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-warning-text)]">{model.lockNotice}</p>
            <a
              href="/admin/settings/guardrails"
              className="adm-focusable text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-accent)] hover:underline"
            >
              Change it in Guardrails
            </a>
          </div>
        </div>
      ) : null}

      <Card
        kicker="Applied contract"
        title="What this publication's images look like"
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={model.applied.source.kind === 'unrecorded' ? 'neutral' : 'accent'}>
              {model.applied.source.label}
            </Badge>
            {model.applied.appliedAt ? (
              <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                applied {model.applied.appliedAt}
              </span>
            ) : null}
          </span>
        }
      >
        <ContractBody contract={model.applied} />
      </Card>

      <Card
        kicker="Standards"
        title="The house standard and its templates"
        actions={
          <Button variant="secondary" size="sm" onClick={() => setNewTemplateOpen(true)} disabled={busy}>
            <IconPlus size={15} /> New template
          </Button>
        }
      >
        {model.emptyState ? (
          <EmptyState
            title={model.emptyState.title}
            message={model.emptyState.message}
            action={
              <Button onClick={() => onIntent(buildProposeContractIntent({ standard: undefined, mode: 'house' }))}>
                <IconSparkles size={15} /> Write the house standard
              </Button>
            }
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {model.standards.map((standard) => {
              const active = standard.objectId === selected?.objectId;
              return (
                <button
                  key={standard.objectId}
                  type="button"
                  onClick={() => setSelectedId(standard.objectId)}
                  aria-pressed={active}
                  className={`adm-focusable inline-flex items-center gap-2 rounded-[var(--adm-radius-pill)] border px-3 py-1.5 text-[length:var(--adm-text-sm)] ${
                    active
                      ? 'border-[var(--adm-accent)] bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]'
                      : 'border-[var(--adm-border-strong)] text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]'
                  }`}
                >
                  {standard.label}
                  <Badge tone={standard.isHouse ? 'accent' : 'neutral'}>
                    {standard.isHouse ? 'house' : 'template'}
                  </Badge>
                  {standard.appliedToSite ? <Badge tone="success">applied</Badge> : null}
                  {standard.status === 'draft' ? <Badge tone="warning">draft</Badge> : null}
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {selected ? (
        <>
          <Card
            kicker={selected.isHouse ? 'House standard' : 'Template'}
            title={selected.label}
            actions={
              <span className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void runPropose()}
                  disabled={busy || proposing}
                >
                  <IconSparkles size={15} /> {proposing ? 'Proposing…' : 'Write contract from mood board'}
                </Button>
                <Button size="sm" onClick={() => void previewApply()} disabled={busy || !model.canApply}>
                  Make this the site&rsquo;s imagery
                </Button>
              </span>
            }
            footer={
              model.canApply ? undefined : (
                <span className={MUTED}>Applying a standard to the publication needs the Owner role.</span>
              )
            }
          >
            <div className="flex flex-col gap-4">
              {selected.description ? <p className={MUTED}>{selected.description}</p> : null}
              {selected.whenToUse ? (
                <p className={MUTED}>
                  <span className="font-medium text-[var(--adm-text)]">When to use: </span>
                  {selected.whenToUse}
                </p>
              ) : null}
              <ContractBody contract={selected.contract} />
              <Textarea
                label="Brief for the writer (optional)"
                hint="Steers how the mood board is read. Never write style words into an image prompt — that is what this contract is for."
                rows={2}
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
              />
            </div>
          </Card>

          {proposeResult && proposeResult.standardId === selected.objectId ? (
            <Card
              kicker="Proposed contract"
              title={typeof proposeResult.response.proposal.label === 'string' ? proposeResult.response.proposal.label : 'Untitled proposal'}
            >
              <div className="flex flex-col gap-3">
                <Badge tone={proposeResult.response.warnings.length > 0 ? 'warning' : 'accent'}>
                  {referencesReachedWriterLabel(proposeResult.response)}
                </Badge>
                {proposeResult.response.warnings.length > 0 ? (
                  <div className="flex items-start gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] p-2 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                    <IconAlertTriangle size={15} />
                    <span>
                      Some references never reached the writer, so this proposal may not reflect the whole mood
                      board: {proposeResult.response.warnings.join(', ')}
                    </span>
                  </div>
                ) : null}
                {typeof proposeResult.response.proposal.rationale === 'string' ? (
                  <p className={MUTED}>{proposeResult.response.proposal.rationale}</p>
                ) : null}
              </div>
            </Card>
          ) : null}

          {applyDiff && applyDiff.standardId === selected.objectId ? (
            <div className="flex flex-col gap-3">
              <DiffCard
                diff={applyDiff.diff}
                title={`Applying ${selected.label} to the publication`}
                note="This is the dry run. Nothing is written until you confirm, and the site still has to be published to go live."
              />
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void confirmApply()} disabled={busy}>
                  {busy ? 'Applying…' : 'Confirm and apply'}
                </Button>
                <Button variant="secondary" onClick={() => setApplyDiff(undefined)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          <MoodBoard
            key={selected.objectId}
            standard={selected}
            canEdit={model.canEditBoard}
            busy={busy}
            onSave={saveReferences}
          />

          <Card kicker="Add reference" title="Import by address, or pick from the library">
            <div className="flex flex-col gap-3">
              <Textarea
                label="Image addresses"
                hint="One https:// address per line. They are fetched server-side into this publication's image store."
                rows={3}
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
              />
              <Input
                label="Note for the imported references"
                hint="What these are for — the palette, not the subject."
                maxLength={200}
                value={importNote}
                onChange={(event) => setImportNote(event.target.value)}
              />
              {importPreview.rejected.length ? (
                <ul className="flex flex-col gap-1">
                  {importPreview.rejected.map((entry) => (
                    <li
                      key={entry.value}
                      className="flex items-center gap-2 text-[length:var(--adm-text-xs)] text-[var(--adm-warning-text)]"
                    >
                      <IconAlertTriangle size={14} /> {entry.value} — {entry.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={importPreview.urls.length === 0 || importing || !model.canEditBoard}
                  onClick={() => void runImport()}
                >
                  {importing
                    ? 'Importing…'
                    : `Import ${importPreview.urls.length || ''} reference${importPreview.urls.length === 1 ? '' : 's'}`}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void openLibrary()} disabled={busy || importing}>
                  Pick from library
                </Button>
              </div>
              {importProgress.length ? (
                <ul className="flex flex-col gap-1">
                  {importProgress.map((row) => (
                    <li key={row.url} className="flex items-start gap-2 text-[length:var(--adm-text-xs)]">
                      <span className={IMPORT_STATE_CLASS[row.state]}>{IMPORT_STATE_LABEL[row.state]}</span>
                      <span className="truncate text-[var(--adm-text-muted)]">{row.url}</span>
                      {row.error ? <span className="text-[var(--adm-warning-text)]">{row.error}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className={MUTED}>
                Each address is fetched server-side into this publication&rsquo;s own image store, one at a time, and
                added to this mood board as it lands — at most {MOOD_BOARD_MAX_REFERENCES} references in total.
              </p>
            </div>
          </Card>

          <Card
            kicker="Examples"
            title="Rendered examples for this standard"
            actions={
              model.examples.canRegenerate ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const regenIntent = buildRegenerateExamplesIntent(selected);
                    if (regenIntent) onIntent(regenIntent);
                  }}
                >
                  <IconSparkles size={15} /> Regenerate examples
                </Button>
              ) : undefined
            }
          >
            {model.examples.items.length > 0 ? (
              <ExamplesStrip items={model.examples.items} />
            ) : (
              <EmptyState
                title={model.examples.emptyState?.title ?? 'No examples yet'}
                message={model.examples.emptyState?.message ?? ''}
              />
            )}
          </Card>
        </>
      ) : null}

      <LibraryPicker
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        artifacts={library}
        loading={libraryLoading}
        {...(libraryError ? { error: libraryError } : {})}
        onPick={(artifact) => void pickFromLibrary(artifact)}
      />

      <Dialog
        open={newTemplateOpen}
        onClose={() => setNewTemplateOpen(false)}
        title="New template"
        description="A template starts as a clone of the selected standard's contract, with its own empty mood board."
        footer={
          <span className="flex gap-2">
            <Button variant="secondary" onClick={() => setNewTemplateOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void createTemplate()} disabled={busy || !newTemplateLabel.trim()}>
              Create draft
            </Button>
          </span>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Name"
            maxLength={80}
            value={newTemplateLabel}
            onChange={(event) => setNewTemplateLabel(event.target.value)}
          />
          <Textarea
            label="When to use"
            hint="Agent-facing: how a run decides between this template and its siblings."
            rows={2}
            maxLength={400}
            value={newTemplateWhenToUse}
            onChange={(event) => setNewTemplateWhenToUse(event.target.value)}
          />
        </div>
      </Dialog>
    </div>
  );
}

export default ImageryBoard;
