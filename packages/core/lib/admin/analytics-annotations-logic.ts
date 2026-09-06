/**
 * Analytics annotations (T21.29; runner R11.3) — pure logic. Three sources
 * become one flat, sorted list of markers the chart draws ticks from and the
 * "what shipped" hover reads: Netlify release receipts, `publish` entries
 * off any object's `history[]`, and operator notes (`analytics-views-logic.ts`'s
 * `AnalyticsNote` — the same small Blobs store as saved views, per that
 * module's header: this is a dashboard annotation, not a changelog page).
 *
 * No I/O here — `server/lib/analytics-annotations.ts` gathers the three raw
 * inputs (deploy receipts, object records, notes) and calls the builders
 * below; the server module is what's untested-in-lib, matching
 * `netlify-deploys.ts`'s own `mapNetlifyDeployToReceipt` staying server-side.
 */

export type AnnotationKind = 'release' | 'publish' | 'note';

export interface AnnotationMarker {
  id: string;
  /** ISO timestamp (release/publish) or `YYYY-MM-DD` (a note) — either sorts correctly against the other since both are ISO-prefixed. */
  at: string;
  kind: AnnotationKind;
  label: string;
  detail?: string;
  /** An admin link to open for more — the object workspace for a publish marker. Absent for a release or a note (nowhere else to send the click). */
  href?: string;
}

// ─── release markers (Netlify deploy receipts) ─────────────────────────────

/** The handful of `DeployReceipt` fields this needs — kept narrow so this pure module never imports the server-only `netlify-deploys.ts`. */
export interface ReleaseDeployLike {
  deployId: string;
  deployStatus: string;
  finishedAt: string;
  commit: string;
}

/** Only `ready` deploys with a known finish time are markers — a still-building or failed deploy never shipped anything to annotate. */
export function releaseMarkersFromDeploys(deploys: readonly ReleaseDeployLike[]): AnnotationMarker[] {
  return deploys
    .filter((deploy) => deploy.deployStatus === 'ready' && deploy.finishedAt)
    .map((deploy) => ({
      id: `release_${deploy.deployId}`,
      at: deploy.finishedAt,
      kind: 'release' as const,
      label: 'Release',
      detail: deploy.commit ? `Deploy ${deploy.commit.slice(0, 7)}` : 'Deploy',
    }));
}

// ─── publish markers (object history[]) ─────────────────────────────────────

/** One `publish` history entry, already flattened off its owning record. */
export interface PublishHistoryEntryLike {
  objectId: string;
  objectType: string;
  at: string;
  /** The resolved title, when the caller could look it up (D6 — never a bare id on screen). */
  title?: string;
  /** The admin object-workspace link, when resolvable. */
  adminHref?: string;
}

export function publishMarkersFromHistory(entries: readonly PublishHistoryEntryLike[]): AnnotationMarker[] {
  return entries.map((entry) => ({
    id: `publish_${entry.objectId}_${entry.at}`,
    at: entry.at,
    kind: 'publish' as const,
    label: entry.title ? `Published: ${entry.title}` : `Published ${entry.objectType} ${entry.objectId}`,
    href: entry.adminHref,
  }));
}

/** The minimal shape `server/lib/analytics-annotations.ts`'s object-store sweep reduces a real `ObjectRecord` to — kept narrow so this pure module never imports the schema/store layer. */
export interface AnnotatableObjectRecordLike {
  objectId: string;
  objectType: string;
  /** The resolved title, when the record body carries one (D6 — never a bare id on screen). */
  title?: string;
  adminHref?: string;
  history: ReadonlyArray<{ action: string; at: string }>;
}

/** Only these two types are reader-facing, publicly-titled content whose publish is a "what shipped" event — the same restriction `admin-analytics.ts`'s `publishingSurfaces` join already applies to `top_objects`. */
const PUBLISHABLE_OBJECT_TYPES = new Set(['content_item', 'page']);

/**
 * The selection logic behind the object-store sweep: which `publish`
 * history entries, off which object types, land in the window — kept here
 * (not in `server/lib/analytics-annotations.ts`) so it is testable without
 * a Blobs store fake.
 */
export function publishMarkersFromRecords(
  records: readonly AnnotatableObjectRecordLike[],
  fromIso: string,
  toIso: string
): AnnotationMarker[] {
  const entries: PublishHistoryEntryLike[] = [];
  for (const record of records) {
    if (!PUBLISHABLE_OBJECT_TYPES.has(record.objectType)) continue;
    for (const entry of record.history) {
      if (entry.action !== 'publish') continue;
      if (entry.at < fromIso || entry.at > toIso) continue;
      entries.push({
        objectId: record.objectId,
        objectType: record.objectType,
        at: entry.at,
        title: record.title,
        adminHref: record.adminHref,
      });
    }
  }
  return publishMarkersFromHistory(entries);
}

// ─── note markers ───────────────────────────────────────────────────────────

/** The handful of `AnalyticsNote` fields this needs (kept narrow for the same reason as `ReleaseDeployLike`). */
export interface AnnotationNoteLike {
  id: string;
  date: string;
  text: string;
}

export function noteMarkersFromNotes(notes: readonly AnnotationNoteLike[]): AnnotationMarker[] {
  return notes.map((note) => ({ id: note.id, at: note.date, kind: 'note' as const, label: note.text }));
}

// ─── merge / query ──────────────────────────────────────────────────────────

const byAtAscending = (a: AnnotationMarker, b: AnnotationMarker): number => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

export function mergeAnnotationMarkers(...groups: ReadonlyArray<readonly AnnotationMarker[]>): AnnotationMarker[] {
  return groups.flat().sort(byAtAscending);
}

/** Inclusive of both endpoints — string comparison works because every `at` is ISO-prefixed (`YYYY-MM-DD` sorts identically to a full timestamp on the same day). */
export function markersInRange(
  markers: readonly AnnotationMarker[],
  fromIso: string,
  toIso: string
): AnnotationMarker[] {
  return markers.filter((marker) => marker.at >= fromIso && marker.at <= toIso);
}

/** Buckets by calendar day (`YYYY-MM-DD`) — what the chart's draw hook looks up per x-tick, and what "click a day to add a note" needs to know is already annotated. */
export function groupMarkersByDay(markers: readonly AnnotationMarker[]): Record<string, AnnotationMarker[]> {
  const byDay: Record<string, AnnotationMarker[]> = {};
  for (const marker of markers) {
    const day = marker.at.slice(0, 10);
    (byDay[day] ??= []).push(marker);
  }
  return byDay;
}
