/**
 * Interactive controls blocks in agent chats (T-chat-interactive-controls):
 * renders a valid `controls` fenced block (see `chat-controls.ts` for the
 * parser + `docs/cms-architecture/chat-controls-protocol.md` for the spec) as
 * a clickable card — radio/checkbox groups + toggles — instead of asking the
 * editor to type an answer.
 *
 * Submitted state is derived from the transcript (a later user message
 * carrying `[controls:<id>]`), never from local state alone, so it survives a
 * refetch/reload with no server changes: `submittedText`, when present, comes
 * straight from that later message and the card renders read-only.
 */
import { useState } from 'react';

import { Button, Card } from './primitives';
import { Switch } from './forms';
import { IconCheck } from './icons';
import { cn } from './utils';
import {
  defaultControlsValues,
  formatControlsBrief,
  parseControlsBrief,
  type ControlsBlock,
  type ControlsField,
  type ControlsValues,
} from '@core/lib/admin/chat-controls';

function FieldControl({
  field,
  value,
  readOnlyDisplay,
  disabled,
  onRadioChange,
  onCheckboxToggle,
  onToggleChange,
}: {
  field: ControlsField;
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
        <span className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
          {field.label}
        </span>
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
      <legend className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
        {field.label}
      </legend>
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

export function ControlsCard({
  block,
  submittedText,
  busy,
  onSubmit,
}: {
  block: ControlsBlock;
  /** The later transcript message carrying this block's `[controls:id]` marker, when it exists. */
  submittedText?: string;
  busy: boolean;
  onSubmit: (brief: string) => void;
}) {
  const [values, setValues] = useState<ControlsValues>(() => defaultControlsValues(block));
  const readOnly = submittedText !== undefined;
  // Sourced from the transcript message itself, never from local state —
  // this is what makes the read-only view survive a reload.
  const submittedSummary = readOnly ? parseControlsBrief(submittedText) : null;

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
    <Card
      kicker={readOnly ? 'Selections sent' : 'Choose options'}
      title={block.title ?? 'Choose options'}
      className="max-w-[26rem] bg-[var(--adm-surface-sunken)] shadow-none"
    >
      <div className="flex flex-col gap-4">
        {block.fields.map((field, index) => (
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
      {readOnly ? (
        <p className="mt-4 flex items-center gap-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-success)]">
          <IconCheck size={13} />
          Sent to the agent.
        </p>
      ) : (
        <Button className="mt-4 w-full" size="sm" onClick={submit} disabled={busy} loading={busy}>
          {block.submit ?? 'Submit'}
        </Button>
      )}
    </Card>
  );
}
