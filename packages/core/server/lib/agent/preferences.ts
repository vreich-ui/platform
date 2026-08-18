import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { CandidateOption } from './candidates.js';
import type { AgentLearningRecord, ManualRichTextEdit } from '../../../lib/admin/agent-learning-trail.js';
import { collectBlobListItems, type BlobListResponse } from '../blob-list.js';

const candidateEvidenceSchema = z.object({
  candidate_id: z.string(),
  content: z.string(),
  self_description: z.string(),
});

export const preferenceEventSchema = z.object({
  schema_version: z.literal('preference-event.v1'),
  event_id: z.string(),
  at: z.string(),
  site: z.string(),
  chat_id: z.string(),
  run_id: z.string(),
  object_id: z.string().optional(),
  object_type: z.string().optional(),
  focus: z.string().optional(),
  prompt_context: z.string(),
  candidates: z.array(candidateEvidenceSchema).min(2).max(3),
  chosen_id: z.string().nullable(),
  rejected_ids: z.array(z.string()),
  none_chosen: z.object({ reason: z.string() }).optional(),
  post_edit_delta: z.unknown().optional(),
  editor_email: z.string(),
  profile_id: z.string(),
  model: z.string(),
});
export type PreferenceEvent = z.infer<typeof preferenceEventSchema>;

export interface LearningEvidenceStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<void | { modified: boolean; etag?: string }>;
  list(options: {
    prefix: string;
    directories?: boolean;
    paginate?: boolean;
  }): BlobListResponse | Promise<BlobListResponse>;
}

const privateKey = /private|strategy|agentnotes|system[_-]?prompt|authorization|password|secret|token/i;

/** Learning evidence must never become a shadow copy of secrets or private strategy. */
export const sanitizeLearningValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeLearningValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !privateKey.test(key))
      .map(([key, child]) => [key, sanitizeLearningValue(child)])
  );
};

const preferenceKey = (eventId: string): string => `preferences/by-event/${eventId}.json`;

export const createPreferenceEvent = async (
  store: LearningEvidenceStore,
  input: {
    at: string;
    event_id?: string;
    site: string;
    chat_id: string;
    run_id: string;
    object_id?: string;
    object_type?: string;
    focus?: string;
    prompt_context: string;
    candidates: readonly CandidateOption[];
    chosen_id: string | null;
    none_reason?: string;
    editor_email: string;
    profile_id: string;
    model: string;
  }
): Promise<{ event: PreferenceEvent; key: string }> => {
  const eventId = input.event_id ?? `pref_${randomUUID().replaceAll('-', '')}`;
  const event: PreferenceEvent = preferenceEventSchema.parse({
    schema_version: 'preference-event.v1',
    event_id: eventId,
    at: input.at,
    site: input.site,
    chat_id: input.chat_id,
    run_id: input.run_id,
    ...(input.object_id ? { object_id: input.object_id } : {}),
    ...(input.object_type ? { object_type: input.object_type } : {}),
    ...(input.focus ? { focus: input.focus } : {}),
    prompt_context: input.prompt_context,
    candidates: input.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      content: candidate.content,
      self_description: candidate.self_description,
    })),
    chosen_id: input.chosen_id,
    rejected_ids: input.candidates
      .map((candidate) => candidate.candidate_id)
      .filter((candidateId) => candidateId !== input.chosen_id),
    ...(input.none_reason ? { none_chosen: { reason: input.none_reason } } : {}),
    editor_email: input.editor_email,
    profile_id: input.profile_id,
    model: input.model,
  });
  const key = preferenceKey(eventId);
  await store.setJSON(key, event);
  return { event, key };
};

export const addPostEditDelta = async (
  store: LearningEvidenceStore,
  key: string,
  chosenArgs: Record<string, unknown>,
  approvedArgs: Record<string, unknown>
): Promise<void> => {
  const raw = await store.get(key);
  if (!raw) return;
  const parsed = preferenceEventSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return;
  await store.setJSON(key, {
    ...parsed.data,
    post_edit_delta: sanitizeLearningValue({ chosen: chosenArgs, approved: approvedArgs }),
  });
};

const listJson = async (
  store: LearningEvidenceStore,
  prefix: string
): Promise<Array<{ key: string; value: unknown }>> => {
  const items = await collectBlobListItems(await store.list({ prefix, directories: false, paginate: true }));
  const values: Array<{ key: string; value: unknown }> = [];
  for (const blob of items) {
    const raw = await store.get(blob.key);
    if (!raw) continue;
    try {
      values.push({ key: blob.key, value: JSON.parse(raw) as unknown });
    } catch {
      // Corrupt evidence is skipped rather than making an Owner export fail.
    }
  }
  return values;
};

export interface PreferenceExport {
  jsonl: string;
  count: number;
  candidate_events: number;
  manual_edits: number;
  hard_negatives: number;
}

const pairLine = (input: {
  prompt: Record<string, unknown>;
  chosen: unknown;
  rejected: unknown;
  metadata: Record<string, unknown>;
}): string =>
  JSON.stringify({
    prompt: JSON.stringify(input.prompt),
    chosen: JSON.stringify(input.chosen),
    rejected: JSON.stringify(input.rejected),
    metadata: input.metadata,
  });

/** Aligns exactly with CMS-Agent dataset.export_preferences' four top-level columns. */
export const exportPreferencePairs = async (store: LearningEvidenceStore): Promise<PreferenceExport> => {
  const lines: string[] = [];
  let candidateEvents = 0;
  let manualEdits = 0;
  let hardNegatives = 0;

  for (const entry of await listJson(store, 'preferences/')) {
    const parsed = preferenceEventSchema.safeParse(entry.value);
    if (!parsed.success) continue;
    candidateEvents += 1;
    const event = parsed.data;
    if (!event.chosen_id) {
      hardNegatives += event.rejected_ids.length;
      continue;
    }
    const chosen = event.candidates.find((candidate) => candidate.candidate_id === event.chosen_id);
    if (!chosen) continue;
    for (const rejectedId of event.rejected_ids) {
      const rejected = event.candidates.find((candidate) => candidate.candidate_id === rejectedId);
      if (!rejected) continue;
      lines.push(
        pairLine({
          prompt: {
            input: event.prompt_context,
            ...(event.focus ? { focus: event.focus } : {}),
            ...(event.object_type ? { object_type: event.object_type } : {}),
          },
          chosen: chosen.content,
          rejected: rejected.content,
          metadata: {
            eventId: event.event_id,
            runId: event.run_id,
            objectId: event.object_id,
            source: 'human_candidate_choice',
            ...(event.post_edit_delta !== undefined ? { postEditDelta: event.post_edit_delta } : {}),
          },
        })
      );
    }
  }

  for (const entry of await listJson(store, 'learning/')) {
    const record = entry.value as Partial<AgentLearningRecord>;
    if (!Array.isArray(record.manual_edits)) continue;
    for (const edit of record.manual_edits as ManualRichTextEdit[]) {
      manualEdits += 1;
      lines.push(
        pairLine({
          prompt: {
            input: edit.surrounding_context,
            focus: edit.focus,
            object_type: record.object_type,
          },
          chosen: edit.replacement_text,
          rejected: edit.original_text,
          metadata: {
            source: 'manual_rich_text_edit',
            objectId: record.object_id,
            at: edit.at,
          },
        })
      );
    }
  }

  return {
    jsonl: lines.join('\n'),
    count: lines.length,
    candidate_events: candidateEvents,
    manual_edits: manualEdits,
    hard_negatives: hardNegatives,
  };
};
