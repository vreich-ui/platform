/**
 * Analytics raw-export client (T21.28; runner R11.2) — browser wrapper over
 * `admin-analytics?resource=raw_export`. The credential this file attaches
 * is the admin's own Identity bearer token, the same one every other
 * admin-analytics request already carries — the SINK's own Bearer token
 * (`TRACKING_SINK_TOKEN`) is attached server-side only, inside
 * `server/lib/own-tracker-stats.ts`'s `fetchOwnTrackerRawExport`, and never
 * reaches this file or the browser.
 *
 * Returns a `Blob` rather than triggering the download itself — the DOM
 * side effect (an anchor click) is a presentational concern that stays in
 * the component, matching this repo's "pure logic vs I/O" split.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import { rawExportFilename } from './analytics-export-logic.js';
import { currentPageSignal } from './page-generation.js';

const ENDPOINT = '/.netlify/functions/admin-analytics';

export type AnalyticsRawExportKind = 'events' | 'commerce' | 'dims';

export type AnalyticsRawExportResult =
  | { available: true; blob: Blob; filename: string }
  | { available: false; message: string };

/**
 * Never throws — every failure (network, a JSON `{available:false}` degrade
 * from the server, any other non-2xx) resolves to `{available: false,
 * message}` so the caller can show a named state instead of a broken
 * download.
 */
export async function fetchAnalyticsRawExport(
  getToken: GetToken,
  kind: AnalyticsRawExportKind,
  range: { from: string; to: string }
): Promise<AnalyticsRawExportResult> {
  const query = new URLSearchParams({ resource: 'raw_export', kind, from: range.from, to: range.to }).toString();

  let response: Response;
  try {
    const token = await getToken();
    // T1.1: a read (the export the button downloads), and this already
    // degrades any fetch failure — abort included — to a named unavailable
    // state below rather than throwing, so no AbortError-specific handling
    // is needed at the call site.
    response = await fetch(`${ENDPOINT}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: currentPageSignal(),
    });
  } catch {
    return { available: false, message: 'Could not reach the server.' };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await response.json().catch(() => ({}))) as {
      available?: boolean;
      message?: string;
      error?: string;
    };
    return { available: false, message: body.message ?? body.error ?? `Request failed (${response.status}).` };
  }
  if (!response.ok) return { available: false, message: `Request failed (${response.status}).` };

  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? rawExportFilename(kind, range.from, range.to);
  return { available: true, blob: await response.blob(), filename };
}
