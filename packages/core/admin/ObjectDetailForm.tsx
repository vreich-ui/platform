/**
 * Object detail — the direct edit form (T2.2, D2).
 *
 * The other half of "editable both ways": this form and the agent write the
 * SAME fields through the SAME governed verbs. There is exactly one write
 * path in this file — `commitFieldOps` — and it is `checkout → patch →
 * checkin` on `EditSession` (`lib/edit-mode/verbs-client.ts`), the identical
 * sequence `ObjectWorkspace`'s article-settings card and the chat agent's
 * `patch` tool already use. No side channel, no direct endpoint call.
 *
 * Round-tripping is the acceptance criterion, so it is explicit rather than
 * incidental:
 *
 *   form → chat   the save re-reads the record (the host reloads and passes
 *                 a new `record` down), so the agent's next turn sees the
 *                 committed body, not a stale one.
 *   chat → form   the host bumps `record` whenever a chat write lands
 *                 (`useChat().writeStamp`); this component reconciles that
 *                 record against the editor's in-progress draft through
 *                 `reconcileFormDraft` (`lib/admin/object-detail-form.ts`) —
 *                 untouched fields adopt the agent's text, touched fields
 *                 keep the editor's, and a genuine collision is surfaced as
 *                 a conflict with the agent's version one click away.
 *
 * The last line of defence is the server's, not this file's: `patch` carries
 * `expected_record_version`, so a concurrent write that this component never
 * saw still fails the version check (409 → one retry against the fresh
 * version inside `EditSession.patch`) rather than silently clobbering.
 */
import { useEffect, useRef, useState } from 'react';

import { Button } from './primitives';
import { Input, Textarea } from './forms';
import { useToast } from './overlays';
import { cn } from './utils';
import type { GetToken } from '@core/lib/edit-mode/verbs-client';
import type { ObjectRecord } from '@core/schema/object-record-v1';
import {
  acceptIncomingField,
  buildFormPatchOps,
  dirtyFields,
  objectFormFields,
  readFormValues,
  reconcileFormDraft,
  structuredFieldNote,
  validateFormValues,
  type FieldsPatchOp,
  type FormValues,
} from '@core/lib/admin/object-detail-form';

type Rec = ObjectRecord<Record<string, unknown>>;

export type CommitOutcome = { ok: true } | { ok: false; error: string };

/**
 * The one write this surface performs. Exported so the header's inline
 * title/excerpt edits go through exactly the same verbs as the form below
 * rather than growing a second, subtly different path.
 */
export async function commitFieldOps(record: Rec, ops: FieldsPatchOp[], getToken: GetToken): Promise<CommitOutcome> {
  if (ops.length === 0) return { ok: true };
  const { EditSession } = await import('@core/lib/edit-mode/verbs-client');
  const session = new EditSession(record.object_type, record.object_id, getToken);
  const checkout = await session.ensureCheckout();
  if (!checkout.ok) {
    return { ok: false, error: checkout.heldBy ? `Checked out by ${checkout.heldBy}.` : 'Could not check this out.' };
  }
  try {
    const outcome = await session.patch(ops as unknown as Array<Record<string, unknown>>);
    if (outcome.ok) return { ok: true };
    return { ok: false, error: [outcome.error, ...(outcome.blockers ?? [])].filter(Boolean).join(' · ') };
  } finally {
    await session.checkin();
  }
}

export interface ObjectDetailFormProps {
  record: Rec;
  getToken: GetToken;
  /** Disabled-with-a-reason (T0.3 A4) — never hide the form, say why it is read-only. */
  disabledReason?: string;
  /** Called after a successful save so the host re-reads the record. */
  onSaved: () => Promise<void> | void;
}

export function ObjectDetailForm({ record, getToken, disabledReason, onSaved }: ObjectDetailFormProps) {
  const { toast } = useToast();
  const fields = objectFormFields(record.object_type);
  const [base, setBase] = useState<FormValues>(() => readFormValues(record));
  const [draft, setDraft] = useState<FormValues>(() => readFormValues(record));
  const [conflicts, setConflicts] = useState<Array<{ id: string; mine: string; theirs: string }>>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Reconcile on a genuinely NEW record only. `version` bumps on every
  // accepted write (including lock ops), which is exactly the "something
  // landed underneath me" signal this needs.
  const seenVersion = useRef(record.version);

  useEffect(() => {
    if (record.version === seenVersion.current) return;
    seenVersion.current = record.version;
    const incoming = readFormValues(record);
    const result = reconcileFormDraft({ base, draft, incoming });
    setBase(result.base);
    setDraft(result.values);
    setConflicts(result.conflicts);
    if (result.adopted.length > 0 && result.conflicts.length === 0) {
      toast({
        title: 'Updated by the agent',
        description: `${result.adopted.length} field${result.adopted.length === 1 ? '' : 's'} refreshed here.`,
        tone: 'info',
      });
    }
  }, [record]);

  if (fields.length === 0) return null;

  const readOnly = Boolean(disabledReason) || busy;
  const changed = dirtyFields(base, draft);
  const note = structuredFieldNote(record.object_type);

  const save = async () => {
    const problems = validateFormValues(record.object_type, draft);
    if (problems.length > 0) {
      setErrors(Object.fromEntries(problems.map((problem) => [problem.id, problem.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const outcome = await commitFieldOps(record, buildFormPatchOps(record.object_type, base, draft), getToken);
      if (!outcome.ok) {
        toast({ title: 'Not saved', description: outcome.error, tone: 'danger' });
        return;
      }
      setConflicts([]);
      toast({ title: 'Saved as a draft', tone: 'success' });
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  const revert = () => {
    setDraft({ ...base });
    setConflicts([]);
    setErrors({});
  };

  return (
    <div className="flex flex-col gap-3">
      {disabledReason ? (
        <p className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] px-3 py-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {disabledReason}
        </p>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-warning)] bg-[var(--adm-warning-soft)] px-3 py-2">
          <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-warning-text)]">
            The agent changed {conflicts.length === 1 ? 'a field' : 'fields'} you are also editing. Your text is kept —
            take theirs if you prefer it.
          </p>
          {conflicts.map((conflict) => (
            <div key={conflict.id} className="flex flex-wrap items-center gap-2">
              <span className="text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-warning-text)]">
                {fields.find((field) => field.id === conflict.id)?.label ?? conflict.id}
              </span>
              <span className="min-w-0 flex-1 truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text)]">
                {conflict.theirs || '—'}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDraft((values) => acceptIncomingField(values, conflict.id, conflict.theirs));
                  setConflicts((rest) => rest.filter((item) => item.id !== conflict.id));
                }}
              >
                Use the agent&rsquo;s
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {fields.map((field) => {
        const value = draft[field.id] ?? '';
        const onChange = (next: string) => setDraft((values) => ({ ...values, [field.id]: next }));
        const shared = {
          label: field.label,
          value,
          disabled: readOnly,
          error: errors[field.id],
          hint: field.hint,
        };
        return field.kind === 'text' ? (
          <Input key={field.id} {...shared} onChange={(event) => onChange(event.target.value)} />
        ) : (
          <Textarea
            key={field.id}
            {...shared}
            rows={field.kind === 'lines' ? Math.max(3, value.split('\n').length) : (field.rows ?? 3)}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      })}

      {note ? <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{note}</p> : null}

      <div className={cn('flex flex-wrap items-center gap-2')}>
        <Button
          size="sm"
          onClick={() => void save()}
          loading={busy}
          disabled={readOnly || changed.length === 0}
          title={disabledReason ?? (changed.length === 0 ? 'Nothing has changed yet.' : undefined)}
        >
          Save draft
        </Button>
        <Button size="sm" variant="secondary" onClick={revert} disabled={readOnly || changed.length === 0}>
          Revert
        </Button>
        <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {changed.length === 0
            ? 'Saved. The agent edits these same fields through the same verbs.'
            : `${changed.length} unsaved change${changed.length === 1 ? '' : 's'}.`}
        </span>
      </div>
    </div>
  );
}
