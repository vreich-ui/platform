/**
 * Analytics saved views + operator notes — the `analytics-views` blob store
 * (T21.27/T21.29; runner R11.1/R11.3). I/O only: every shaping/validation
 * decision lives in the pure `lib/admin/analytics-views-logic.ts`, which this
 * module reads and writes through.
 *
 * Two small documents, one per collection — this store never grows past a
 * handful of operator-minted rows (a handful of saved views, notes at most
 * one-per-shipped-day), so unlike `requests/store.ts`'s per-id-doc-plus-index
 * shape (built for potentially thousands of editorial jobs) a single JSON
 * array per collection is the right amount of ceremony: one read, one write,
 * no separate index to keep in sync.
 *
 * Concurrency: read-modify-write, no compare-and-swap (the fleet-wide Blobs
 * reality — see `requests/store.ts`'s header). Acceptable here because the
 * writers are a small number of admin operators clicking "Save view" or
 * "Add note", not a high-frequency automated writer; a lost concurrent write
 * is a rare, low-stakes annoyance ("re-click Save"), not a correctness bug in
 * anything the object substrate or a workflow depends on.
 */
import { randomUUID } from 'node:crypto';

import {
  defaultAnalyticsViews,
  notesInRange,
  sortAnalyticsNotes,
  sortAnalyticsViews,
  type AnalyticsNote,
  type AnalyticsNoteInput,
  type AnalyticsSavedView,
  type AnalyticsViewInput,
} from '../../lib/admin/analytics-views-logic.js';

const nowIso = () => new Date().toISOString();

/** The minimal shape this module needs — `getAnalyticsViewsBlobStore` in blob-store.ts satisfies it. */
export interface AnalyticsViewsStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<void | { modified: boolean; etag?: string }>;
}

const VIEWS_KEY = 'views/index.json';
const NOTES_KEY = 'notes/index.json';

const VIEWS_SCHEMA_VERSION = 'analytics-views-index.v1';
const NOTES_SCHEMA_VERSION = 'analytics-notes-index.v1';

// ─── saved views ────────────────────────────────────────────────────────────

/**
 * List every saved view, seeding the three shipped defaults on an empty (or
 * corrupt/unparseable) store — the ONLY time seeding runs, so a view an
 * operator deleted never comes back just because the list happened to be
 * short afterward. Every call after the first seed is a plain read.
 */
export const listAnalyticsViews = async (
  store: AnalyticsViewsStore,
  at: string = nowIso()
): Promise<AnalyticsSavedView[]> => {
  const raw = await store.get(VIEWS_KEY);
  const parsed = parseViewsDoc(raw);
  if (parsed) return sortAnalyticsViews(parsed);

  const seeded = defaultAnalyticsViews(at);
  await store.setJSON(VIEWS_KEY, { schema_version: VIEWS_SCHEMA_VERSION, views: seeded });
  return sortAnalyticsViews(seeded);
};

function parseViewsDoc(raw: string | null): AnalyticsSavedView[] | undefined {
  if (!raw) return undefined;
  try {
    const doc = JSON.parse(raw) as { views?: unknown };
    return Array.isArray(doc.views) ? (doc.views as AnalyticsSavedView[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create (no `existingId`) or update (`existingId` present) one view. Throws
 * on an update naming a view that does not exist — the caller (the admin
 * function) turns that into a 404, never a silent no-op that would leave the
 * operator's edit unsaved without telling them.
 */
export const saveAnalyticsView = async (
  store: AnalyticsViewsStore,
  input: AnalyticsViewInput,
  existingId?: string,
  at: string = nowIso()
): Promise<AnalyticsSavedView> => {
  const views = await listAnalyticsViews(store, at);

  if (existingId) {
    const idx = views.findIndex((v) => v.id === existingId);
    if (idx === -1) throw new Error(`No saved view "${existingId}".`);
    const updated: AnalyticsSavedView = { ...views[idx]!, ...input, id: existingId, updatedAt: at };
    const next = [...views];
    next[idx] = updated;
    await store.setJSON(VIEWS_KEY, { schema_version: VIEWS_SCHEMA_VERSION, views: next });
    return updated;
  }

  const created: AnalyticsSavedView = {
    ...input,
    id: `view_${randomUUID()}`,
    builtin: false,
    createdAt: at,
    updatedAt: at,
  };
  await store.setJSON(VIEWS_KEY, { schema_version: VIEWS_SCHEMA_VERSION, views: [...views, created] });
  return created;
};

/** `false` when the id was never there (a stale double-click, a race with another tab) — a no-op, never an error. */
export const deleteAnalyticsView = async (
  store: AnalyticsViewsStore,
  id: string,
  at: string = nowIso()
): Promise<boolean> => {
  const views = await listAnalyticsViews(store, at);
  const next = views.filter((v) => v.id !== id);
  if (next.length === views.length) return false;
  await store.setJSON(VIEWS_KEY, { schema_version: VIEWS_SCHEMA_VERSION, views: next });
  return true;
};

// ─── operator notes ─────────────────────────────────────────────────────────

function parseNotesDoc(raw: string | null): AnalyticsNote[] {
  if (!raw) return [];
  try {
    const doc = JSON.parse(raw) as { notes?: unknown };
    return Array.isArray(doc.notes) ? (doc.notes as AnalyticsNote[]) : [];
  } catch {
    return [];
  }
}

/** All notes, or (when `range` is given) only those landing inside it — `analytics-views-logic.ts`'s `notesInRange`. */
export const listAnalyticsNotes = async (
  store: AnalyticsViewsStore,
  range?: { from: string; to: string }
): Promise<AnalyticsNote[]> => {
  const notes = parseNotesDoc(await store.get(NOTES_KEY));
  const scoped = range ? notesInRange(notes, range.from, range.to) : notes;
  return sortAnalyticsNotes(scoped);
};

export const addAnalyticsNote = async (
  store: AnalyticsViewsStore,
  input: AnalyticsNoteInput,
  createdBy: string,
  at: string = nowIso()
): Promise<AnalyticsNote> => {
  const notes = parseNotesDoc(await store.get(NOTES_KEY));
  const note: AnalyticsNote = { ...input, id: `note_${randomUUID()}`, createdBy, createdAt: at };
  await store.setJSON(NOTES_KEY, { schema_version: NOTES_SCHEMA_VERSION, notes: [...notes, note] });
  return note;
};

export const deleteAnalyticsNote = async (store: AnalyticsViewsStore, id: string): Promise<boolean> => {
  const notes = parseNotesDoc(await store.get(NOTES_KEY));
  const next = notes.filter((n) => n.id !== id);
  if (next.length === notes.length) return false;
  await store.setJSON(NOTES_KEY, { schema_version: NOTES_SCHEMA_VERSION, notes: next });
  return true;
};
