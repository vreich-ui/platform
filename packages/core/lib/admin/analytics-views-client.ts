/**
 * Analytics saved-views + annotations client (T21.27/T21.29; runner
 * R11.1/R11.3) — browser wrapper over `admin-analytics?resource=views`
 * (saved views), `?resource=annotations` (the merged release/publish/note
 * marker list a chart draws ticks from), and `?resource=notes` (operator
 * notes CRUD — "click a day to add a note"). Same house pattern as
 * `own-analytics-client.ts`: Identity bearer, typed result, no client-side
 * cache (each of these lists is small and read on demand, not on every
 * render — unlike the KPI/chart data this isn't worth memoizing).
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type {
  AnalyticsNote,
  AnalyticsNoteInput,
  AnalyticsSavedView,
  AnalyticsViewInput,
} from './analytics-views-logic.js';
import type { AnnotationMarker } from './analytics-annotations-logic.js';

const ENDPOINT = '/.netlify/functions/admin-analytics';

async function request<T>(getToken: GetToken, init: RequestInit & { query: Record<string, string> }): Promise<T> {
  const token = await getToken();
  const { query, ...rest } = init;
  const url = `${ENDPOINT}?${new URLSearchParams(query).toString()}`;
  const response = await fetch(url, {
    ...rest,
    headers: { Authorization: `Bearer ${token}`, ...(rest.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error((body as { error?: string }).error || `Request failed (${response.status}).`);
  return body;
}

export async function fetchAnalyticsViews(getToken: GetToken): Promise<AnalyticsSavedView[]> {
  const result = await request<{ views: AnalyticsSavedView[] }>(getToken, {
    query: { resource: 'views' },
    method: 'GET',
  });
  return result.views;
}

export async function saveAnalyticsViewRequest(
  getToken: GetToken,
  input: AnalyticsViewInput,
  id?: string
): Promise<AnalyticsSavedView> {
  const result = await request<{ view: AnalyticsSavedView }>(getToken, {
    query: { resource: 'views' },
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, id }),
  });
  return result.view;
}

export async function deleteAnalyticsViewRequest(getToken: GetToken, id: string): Promise<void> {
  await request<{ deleted: boolean }>(getToken, { query: { resource: 'views', id }, method: 'DELETE' });
}

// ─── R11.3 (T21.29): annotations + operator notes ──────────────────────────

export async function fetchAnnotationMarkers(
  getToken: GetToken,
  range: { from: string; to: string }
): Promise<AnnotationMarker[]> {
  const result = await request<{ markers: AnnotationMarker[] }>(getToken, {
    query: { resource: 'annotations', from: range.from, to: range.to },
    method: 'GET',
  });
  return result.markers;
}

export async function fetchAnalyticsNotes(
  getToken: GetToken,
  range?: { from: string; to: string }
): Promise<AnalyticsNote[]> {
  const result = await request<{ notes: AnalyticsNote[] }>(getToken, {
    query: { resource: 'notes', ...(range ?? {}) },
    method: 'GET',
  });
  return result.notes;
}

export async function addAnalyticsNoteRequest(getToken: GetToken, input: AnalyticsNoteInput): Promise<AnalyticsNote> {
  const result = await request<{ note: AnalyticsNote }>(getToken, {
    query: { resource: 'notes' },
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return result.note;
}

export async function deleteAnalyticsNoteRequest(getToken: GetToken, id: string): Promise<void> {
  await request<{ deleted: boolean }>(getToken, { query: { resource: 'notes', id }, method: 'DELETE' });
}
