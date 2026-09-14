/**
 * Interactive controls blocks in agent chats (T-chat-interactive-controls):
 * renders a valid `controls` fenced block (see `chat-controls.ts` for the
 * parser + `docs/cms-architecture/chat-controls-protocol.md` for the spec) as
 * a clickable card instead of asking the editor to type an answer.
 *
 * Two card shapes, decided by the block's fields (§6):
 *
 *   FORM block   — radio/checkbox groups + toggles, gathered by a submit
 *                  button. v1, §1-§3, unchanged.
 *   ACTION block — exactly one `actions` / `select_object` / `confirm` field
 *                  and no submit button: the click IS the submission.
 *
 * Submitted state is derived from the transcript (a later user message
 * carrying `[controls:<id>]`), never from local state alone, so it survives a
 * refetch/reload with no server changes: `submittedText`, when present, comes
 * straight from that later message and the card renders read-only. That holds
 * for the v2 receipts too — `[controls:<id>] ran <verb>`, `… selected <id>`,
 * `… confirmed`/`… declined` all carry the same marker.
 *
 * Nothing here is a second executor and nothing here names a verb. An
 * `actions` button dispatches through W3's `useObjectActions`
 * (`ObjectActionStrip.tsx`) against the one registry in `quick-actions.ts`,
 * and §6.4's `allowedAction` decides whether it renders enabled or DISABLED
 * WITH THE REASON — never hidden.
 */
import { useState } from 'react';

import { Button, Card, StatusPill } from './primitives';
import { Switch } from './forms';
import { IconCheck } from './icons';
import { Popover, type PopoverTriggerA11yProps } from './overlays';
import { QuickActionPopover } from './QuickActions';
import { useObjectActions, type ObjectActionSurfaceProps } from './ObjectActionStrip';
import { cn } from './utils';
import {
  allowedAction,
  controlsActionField,
  controlsActionValues,
  controlsDecisionLine,
  controlsRanMessage,
  controlsSelectedLine,
  defaultControlsValues,
  formatControlsBrief,
  isControlsActionField,
  parseControlsReceipt,
  type ControlsActionEntry,
  type ControlsActionField,
  type ControlsBlock,
  type ControlsFormField,
  type ControlsObjectEntry,
  type ControlsReceipt,
  type ControlsValues,
} from '@core/lib/admin/chat-controls';
import { buildUiCapabilities } from '@core/lib/admin/ui-capabilities';
import { actionDispatchFor, parseActionTraceLine } from '@core/lib/admin/object-action-strip';
import type { ControlState } from '@core/lib/admin/object-detail-actions';

/**
 * What an `actions` card needs in order to actually run something: the same
 * row/roles/trace bundle the surface already hands `<ObjectActionStrip>`.
 *
 * ABSENT means the transcript has no object in focus — a free chat, the hub —
 * and §6.4's answer for that is not "hide the buttons" but "every button
 * disabled, with the reason". So an unwired surface degrades honestly rather
 * than silently dropping what the agent offered.
 */
export type ControlsActionSurface = ObjectActionSurfaceProps;

const CARD_CLASS = 'max-w-[26rem] bg-[var(--adm-surface-sunken)] shadow-none';

const LABEL_CLASS =
  'text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]';

/**
 * §6 leaves one gap the client cannot honestly paper over: the manifest is
 * rights-filtered but NOT state-filtered (W4.3's own note), while W3's strip
 * resolves `appliesTo` as a PRESENCE gate — so the agent can legitimately name
 * a verb that has no entry on this record right now. A controls button may not
 * be hidden, so it renders disabled saying what is actually true: the action
 * has no subject here. That is a statement about the record, deliberately not
 * about the viewer.
 */
const NOT_APPLICABLE_REASON = 'This action does not apply to this object right now.';

// ─── form block (v1, §1-§3) ─────────────────────────────────────────────────

function FieldControl({
  field,
  value,
  readOnlyDisplay,
  disabled,
  onRadioChange,
  onCheckboxToggle,
  onToggleChange,
}: {
  field: ControlsFormField;
  value: ControlsValues[string] | undefined;
  /** Set when the card is read-only — the value as it appears in the sent brief. */
  readOnlyDisplay?: string;
  disabled: boolean;
  onRadioChange: (value: string) => void;
  onCheckboxToggle: (value: string) => void;
  onToggleChange: (on: boolean) => void;
}) {
  if (readOnlyDisplay !== undefined) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className={LABEL_CLASS}>{field.label}</span>
        <span className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{readOnlyDisplay}</span>
      </div>
    );
  }

  if (field.kind === 'toggle') {
    return <Switch checked={Boolean(value)} onCheckedChange={onToggleChange} label={field.label} disabled={disabled} />;
  }

  const selectedRadio = field.kind === 'radio' && typeof value === 'string' ? value : undefined;
  const selectedCheckboxes = field.kind === 'checkbox' && Array.isArray(value) ? new Set(value) : undefined;

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className={LABEL_CLASS}>{field.label}</legend>
      <div
        className="flex flex-col gap-1.5"
        role={field.kind === 'radio' ? 'radiogroup' : 'group'}
        aria-label={field.label}
      >
        {field.options.map((option) => {
          const inputId = `${field.id}-${option.value}`;
          const checked =
            field.kind === 'radio' ? selectedRadio === option.value : Boolean(selectedCheckboxes?.has(option.value));
          return (
            <label
              key={option.value}
              htmlFor={inputId}
              className={cn(
                'flex items-center gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-2.5 py-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text)]',
                disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-[var(--adm-border-strong)]'
              )}
            >
              <input
                id={inputId}
                type={field.kind === 'radio' ? 'radio' : 'checkbox'}
                name={field.id}
                value={option.value}
                checked={checked}
                disabled={disabled}
                onChange={() => (field.kind === 'radio' ? onRadioChange(option.value) : onCheckboxToggle(option.value))}
                className="adm-focusable h-4 w-4 shrink-0 accent-[var(--adm-accent)]"
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ControlsFormCard({
  block,
  fields,
  submittedText,
  busy,
  onSubmit,
}: {
  block: ControlsBlock;
  fields: ControlsFormField[];
  submittedText?: string;
  busy: boolean;
  onSubmit: (brief: string) => void;
}) {
  const [values, setValues] = useState<ControlsValues>(() => defaultControlsValues(block));
  const readOnly = submittedText !== undefined;
  // Sourced from the transcript message itself, never from local state —
  // this is what makes the read-only view survive a reload.
  const receipt = readOnly ? parseControlsReceipt(block.id, submittedText) : null;
  const submittedSummary = receipt?.kind === 'selections' ? receipt.entries : null;

  const setRadioValue = (fieldId: string, value: string) => setValues((prev) => ({ ...prev, [fieldId]: value }));
  const toggleCheckboxValue = (fieldId: string, optionValue: string) =>
    setValues((prev) => {
      const current = Array.isArray(prev[fieldId]) ? (prev[fieldId] as string[]) : [];
      const next = current.includes(optionValue)
        ? current.filter((existing) => existing !== optionValue)
        : [...current, optionValue];
      return { ...prev, [fieldId]: next };
    });
  const setToggleValue = (fieldId: string, on: boolean) => setValues((prev) => ({ ...prev, [fieldId]: on }));

  const disabled = readOnly || busy;

  const submit = () => {
    if (disabled) return;
    onSubmit(formatControlsBrief(block, values));
  };

  return (
    <Card kicker={readOnly ? 'Selections sent' : 'Choose options'} title={block.title ?? 'Choose options'} className={CARD_CLASS}>
      <div className="flex flex-col gap-4">
        {fields.map((field, index) => (
          <FieldControl
            key={field.id}
            field={field}
            value={values[field.id]}
            readOnlyDisplay={submittedSummary?.[index]?.display}
            disabled={disabled}
            onRadioChange={(value) => setRadioValue(field.id, value)}
            onCheckboxToggle={(value) => toggleCheckboxValue(field.id, value)}
            onToggleChange={(on) => setToggleValue(field.id, on)}
          />
        ))}
      </div>
      {readOnly ? <SentLine /> : (
        <Button className="mt-4 w-full" size="sm" onClick={submit} disabled={busy} loading={busy}>
          {block.submit ?? 'Submit'}
        </Button>
      )}
    </Card>
  );
}

function SentLine() {
  return (
    <p className="mt-4 flex items-center gap-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-success)]">
      <IconCheck size={13} />
      Sent to the agent.
    </p>
  );
}

// ─── action block (v2, §6.1-§6.3) ───────────────────────────────────────────

/**
 * One button in an action card.
 *
 * `state` is the `ControlState` convention this whole layer speaks: enabled,
 * or disabled WITH the reason. The reason must be reachable by keyboard and
 * touch, not only by a mouse hovering a native `title`, which is exactly what
 * `Popover mode="hover" disabled` is built for — the same wrapper
 * `ObjectActionStrip` uses for the same purpose.
 */
function ActionButton({
  label,
  state,
  tone,
  busy,
  loading,
  expanded,
  onActivate,
}: {
  label: string;
  state: ControlState;
  tone?: 'danger';
  busy: boolean;
  loading?: boolean;
  expanded?: boolean;
  onActivate: (anchor: HTMLElement | null) => void;
}) {
  const button = (a11y?: PopoverTriggerA11yProps) => (
    <Button
      size="sm"
      variant={tone === 'danger' ? 'danger' : 'secondary'}
      disabled={!state.enabled || busy}
      loading={loading === true}
      aria-expanded={expanded}
      onClick={(event) => onActivate(event.currentTarget)}
      className="shrink-0"
      {...a11y}
    >
      {label}
    </Button>
  );
  if (state.enabled) return button();
  return <Popover mode="hover" content={state.reason ?? ''} disabled trigger={(a11y) => button(a11y)} />;
}

/**
 * §6.1's row of verbs, wired to W3's executor.
 *
 * The hook is called unconditionally here, which is why this is its own
 * component: a card with no action surface renders `<UnavailableActions>`
 * instead, and a conditional hook call would be the crash this wave is most
 * likely to introduce.
 */
function ControlsActions({
  block,
  field,
  surface,
  busy,
  onSubmit,
}: {
  block: ControlsBlock;
  field: { actions: ControlsActionEntry[]; label: string };
  surface: ControlsActionSurface;
  busy: boolean;
  onSubmit: (text: string) => void;
}) {
  const { entries, openId, busyId, anchorRef, activate, confirm, cancel } = useObjectActions({
    ...surface,
    /**
     * W3.3's trace, redirected through THIS card's send so the run's own
     * `[action:<verb>] …` line and §6.1's `[controls:<id>] ran <verb>` receipt
     * arrive as ONE message — `chat.send` is a turn, and two sends for one
     * click would start two runs. The verb is read back out of the trace line
     * with W3's own inverse parser rather than tracked in a ref.
     *
     * `bound: true` is a fact here, not an assumption: this card is rendered
     * FROM the transcript, so a conversation already exists and there is no
     * lazy binding for a trace to trip (the invariant `actionTraceDelivery`'s
     * guard exists to protect). A hand-off still posts nothing — it seeds the
     * composer, nothing ran, and claiming "ran <verb>" would be false.
     */
    trace: {
      bound: true,
      send: (text) => {
        const verb = parseActionTraceLine(text)?.verb;
        onSubmit(verb ? controlsRanMessage(block.id, verb, text) : text);
      },
    },
  });

  // §6.4's manifest. The client never receives `ui_capabilities` over the wire
  // — Platform sends it to CMS-Agent — so it is rebuilt from the same pure
  // builder with the same inputs (the focused object's type, the viewer's
  // roles) that produced the manifest for the turn. No surface in focus means
  // no surface passes here at all, which is the `undefined` branch below.
  const manifest = buildUiCapabilities(surface.row.object_type, surface.roles);
  const openEntry = entries.find((entry) => entry.id === openId);

  const run = (action: ControlsActionEntry, anchor: HTMLElement | null) => {
    const entry = entries.find((candidate) => candidate.verb === action.verb);
    if (!entry || !entry.state.enabled || busyId) return;
    const values = controlsActionValues(action);
    // §6.1: the block's `args` are PRE-FILLED parameters, so a run whose every
    // parameter is already answered has nothing left to ask for and runs.
    // Anything still missing goes back to `executionFor(params)`' own rule —
    // 0 → immediately, 1 → popover, 2+ → hand back to chat.
    //
    // ASV2-W5 (review) — the rule, including the hand-off exception, is
    // `actionDispatchFor` in `object-action-strip.ts`, tested there. It was an
    // expression here, and it dispatched a fully-pre-filled `agent_chat` entry
    // to the executor, which answers `unsupported`.
    if (actionDispatchFor(entry, values) === 'run') confirm(entry, values);
    else activate(entry, anchor);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={field.label}>
        {field.actions.map((action) => {
          const entry = entries.find((candidate) => candidate.verb === action.verb);
          const offered = allowedAction(action, manifest);
          const state: ControlState = !offered.enabled
            ? offered
            : (entry?.state ?? { enabled: false, reason: NOT_APPLICABLE_REASON });
          return (
            <ActionButton
              key={`${action.verb}-${action.label}`}
              label={action.label}
              state={state}
              {...(action.tone ? { tone: action.tone } : {})}
              busy={busy || Boolean(busyId)}
              loading={entry !== undefined && busyId === entry.id}
              {...(entry?.execution === 'popover' ? { expanded: openId === entry.id } : {})}
              onActivate={(anchor) => run(action, anchor)}
            />
          );
        })}
      </div>
      {openEntry ? (
        <QuickActionPopover
          chip={{ ...openEntry, onSelect: () => {} }}
          anchor={anchorRef.current}
          busy={busyId === openEntry.id}
          onConfirm={(values) => confirm(openEntry, values)}
          onCancel={cancel}
        />
      ) : null}
    </>
  );
}

/** §6.4's other half: no manifest reached the client, so every button is disabled — never hidden. */
function UnavailableActions({ field }: { field: { actions: ControlsActionEntry[]; label: string } }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={field.label}>
      {field.actions.map((action) => (
        <ActionButton
          key={`${action.verb}-${action.label}`}
          label={action.label}
          state={allowedAction(action, undefined)}
          {...(action.tone ? { tone: action.tone } : {})}
          busy={false}
          onActivate={() => {}}
        />
      ))}
    </div>
  );
}

/** The admin's one deep link to an object's workspace, spelled as `ReleaseWorkspace` spells it. */
const objectHref = (object: ControlsObjectEntry) =>
  `/admin/content/${encodeURIComponent(object.object_id)}?type=${encodeURIComponent(object.object_type)}`;

/**
 * §6.2's candidate list, built from the kit's own `Card`-layer pieces
 * (`StatusPill`, `Button`) rather than a second status vocabulary —
 * `primitives.tsx` has no object-card component to reuse, so this follows the
 * shape the transcript already uses for "pick one of a finite set"
 * (`CandidateSetCard` in `chat.tsx`): a labelled group of one row per
 * candidate.
 *
 * Each row is a LINK plus a Choose button, not one big button, for D3's
 * repo-wide invariant (`tests/scripts/admin-object-links.test.mjs`): an
 * object's id rendered as visible text must be one click from open. Nesting
 * an `<a>` inside a `<button>` is invalid markup and would swallow the click,
 * so the two affordances sit side by side — which is also the better card:
 * the editor can LOOK at a candidate before committing to it.
 */
function ControlsObjects({
  objects,
  label,
  busy,
  onPick,
}: {
  objects: ControlsObjectEntry[];
  label: string;
  busy: boolean;
  onPick: (object: ControlsObjectEntry) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      {objects.map((object) => {
        const name = object.title ?? object.object_id;
        return (
          <div
            key={`${object.object_type}:${object.object_id}`}
            className="flex items-center gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-2.5 py-2"
          >
            <a
              href={objectHref(object)}
              className="adm-focusable flex min-w-0 flex-1 flex-col gap-0.5 text-left hover:underline"
            >
              <span className="flex items-center gap-2">
                <strong className="min-w-0 truncate text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
                  {name}
                </strong>
                {object.status ? <StatusPill status={object.status} className="shrink-0" /> : null}
              </span>
              <span className="truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                {object.object_type} · {object.object_id}
              </span>
            </a>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              aria-label={`Choose ${name}`}
              onClick={() => onPick(object)}
              className="shrink-0"
            >
              Choose
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** What the read-only card shows, read back out of the transcript message. */
function receiptDisplay(field: ControlsActionField, receipt: ControlsReceipt | null): string {
  if (!receipt) return 'Sent.';
  if (receipt.kind === 'ran') {
    const named = field.kind === 'actions' ? field.actions.find((action) => action.verb === receipt.verb) : undefined;
    return `Ran ${named?.label ?? receipt.verb}`;
  }
  if (receipt.kind === 'selected') {
    const named =
      field.kind === 'select_object' ? field.objects.find((object) => object.object_id === receipt.object_id) : undefined;
    return named?.title ?? receipt.object_id;
  }
  if (receipt.kind === 'decision') {
    if (field.kind !== 'confirm') return receipt.confirmed ? 'Confirmed' : 'Declined';
    return receipt.confirmed ? (field.confirm_label ?? 'Confirm') : (field.decline_label ?? 'Cancel');
  }
  return receipt.entries.map((entry) => entry.display).join('; ');
}

function ControlsActionCard({
  block,
  field,
  surface,
  submittedText,
  busy,
  onSubmit,
}: {
  block: ControlsBlock;
  field: ControlsActionField;
  surface?: ControlsActionSurface;
  submittedText?: string;
  busy: boolean;
  onSubmit: (text: string) => void;
}) {
  const readOnly = submittedText !== undefined;
  const receipt = readOnly ? parseControlsReceipt(block.id, submittedText) : null;

  return (
    <Card kicker={readOnly ? 'Sent to the agent' : 'Choose an action'} title={block.title ?? field.label} className={CARD_CLASS}>
      <div className="flex flex-col gap-2">
        {/* The card's title already reads as the question when the block gave
            none of its own; repeating it here would say it twice. The group
            below is labelled either way. */}
        {block.title ? <span className={LABEL_CLASS}>{field.label}</span> : null}
        {readOnly ? (
          <span className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{receiptDisplay(field, receipt)}</span>
        ) : field.kind === 'actions' ? (
          surface ? (
            <ControlsActions block={block} field={field} surface={surface} busy={busy} onSubmit={onSubmit} />
          ) : (
            <UnavailableActions field={field} />
          )
        ) : field.kind === 'select_object' ? (
          <ControlsObjects
            objects={field.objects}
            label={field.label}
            busy={busy}
            onPick={(object) => onSubmit(controlsSelectedLine(block.id, object.object_id))}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={field.label}>
            <ActionButton
              label={field.confirm_label ?? 'Confirm'}
              state={{ enabled: true }}
              {...(field.tone ? { tone: field.tone } : {})}
              busy={busy}
              onActivate={() => onSubmit(controlsDecisionLine(block.id, true))}
            />
            <ActionButton
              label={field.decline_label ?? 'Cancel'}
              state={{ enabled: true }}
              busy={busy}
              onActivate={() => onSubmit(controlsDecisionLine(block.id, false))}
            />
          </div>
        )}
      </div>
      {readOnly ? <SentLine /> : null}
    </Card>
  );
}

// ─── the one entry point `chat.tsx` mounts ──────────────────────────────────

export function ControlsCard({
  block,
  submittedText,
  busy,
  onSubmit,
  actionSurface,
}: {
  block: ControlsBlock;
  /** The later transcript message carrying this block's `[controls:id]` marker, when it exists. */
  submittedText?: string;
  busy: boolean;
  onSubmit: (brief: string) => void;
  /** §6.1's executor context. Absent → every action button disabled with §6.4's reason. */
  actionSurface?: ControlsActionSurface;
}) {
  // No hooks in this component: which card is rendered is a fact about the
  // block, and the two shapes hold different state (a form card gathers, an
  // action card does not).
  const field = controlsActionField(block);
  if (field) {
    return (
      <ControlsActionCard
        block={block}
        field={field}
        {...(actionSurface ? { surface: actionSurface } : {})}
        {...(submittedText !== undefined ? { submittedText } : {})}
        busy={busy}
        onSubmit={onSubmit}
      />
    );
  }
  return (
    <ControlsFormCard
      block={block}
      fields={block.fields.filter((candidate): candidate is ControlsFormField => !isControlsActionField(candidate))}
      {...(submittedText !== undefined ? { submittedText } : {})}
      busy={busy}
      onSubmit={onSubmit}
    />
  );
}
