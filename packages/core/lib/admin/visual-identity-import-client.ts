/**
 * Browser client for the deterministic reference import (A1).
 *
 * The Imagery tab's "Import" button calls `admin-visual-identity-import`
 * directly — the endpoint mints the request id, calls pdf-tool through the
 * existing `import_images_from_url` server handler, mirrors the bytes into
 * this site's artifact store and appends `ref_` entries to the standard. The
 * browser therefore sends addresses and nothing else: no ids, no blob keys.
 *
 * ONE URL PER CALL, in order. The endpoint accepts a list, but the tab
 * imports sequentially so a human watching eight addresses fetched
 * server-side sees which one is in flight, which landed, and which failed —
 * rather than one long spinner that either works or does not.
 */
const ENDPOINT = '/.netlify/functions/admin-visual-identity-import';

export type ImportedReference = {
  id: string;
  blobKey: string;
  previewUrl?: string;
  sourceUrl?: string;
  note?: string;
};

export type ImportReferencesResponse = {
  requestId?: string;
  references: ImportedReference[];
  duplicates: ImportedReference[];
  failures: Array<{ source: string; error: string }>;
  referenceCount?: number;
};

export type ImportReferencesInput = {
  standardId: string;
  urls: readonly string[];
  note?: string;
};

type Fetcher = typeof fetch;

export const importVisualReferences = async (
  getToken: () => Promise<string>,
  input: ImportReferencesInput,
  fetchImpl: Fetcher = fetch
): Promise<ImportReferencesResponse> => {
  const token = await getToken();
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      standardId: input.standardId,
      urls: [...input.urls],
      ...(input.note ? { note: input.note } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<
    ImportReferencesResponse & { request_id: string; reference_count: number; error: string }
  >;
  if (!response.ok) throw new Error(body.error || `The import failed (${response.status}).`);
  return {
    ...(body.request_id ? { requestId: body.request_id } : {}),
    references: Array.isArray(body.references) ? body.references : [],
    duplicates: Array.isArray(body.duplicates) ? body.duplicates : [],
    failures: Array.isArray(body.failures) ? body.failures : [],
    ...(typeof body.reference_count === 'number' ? { referenceCount: body.reference_count } : {}),
  };
};

export type ImportProgressState = 'waiting' | 'importing' | 'added' | 'duplicate' | 'failed';
export type ImportProgressRow = { url: string; state: ImportProgressState; error?: string };

export const initialImportProgress = (urls: readonly string[]): ImportProgressRow[] =>
  urls.map((url) => ({ url, state: 'waiting' as const }));

/**
 * Import each address in turn, reporting after every state change. Stops at
 * nothing: one bad address is reported against that row and the rest still
 * import.
 */
export const importVisualReferencesInOrder = async (
  getToken: () => Promise<string>,
  input: ImportReferencesInput,
  onProgress: (rows: ImportProgressRow[]) => void,
  fetchImpl: Fetcher = fetch
): Promise<{ added: ImportedReference[]; rows: ImportProgressRow[] }> => {
  const rows = initialImportProgress(input.urls);
  const added: ImportedReference[] = [];
  const report = () => onProgress(rows.map((row) => ({ ...row })));
  report();

  for (const [index, url] of input.urls.entries()) {
    rows[index] = { url, state: 'importing' };
    report();
    try {
      const result = await importVisualReferences(
        getToken,
        { standardId: input.standardId, urls: [url], ...(input.note ? { note: input.note } : {}) },
        fetchImpl
      );
      const failure = result.failures[0];
      if (result.references.length > 0) {
        added.push(...result.references);
        rows[index] = { url, state: 'added' };
      } else if (result.duplicates.length > 0) {
        rows[index] = { url, state: 'duplicate' };
      } else {
        rows[index] = { url, state: 'failed', error: failure?.error ?? 'Nothing was imported from this address.' };
      }
    } catch (error) {
      rows[index] = { url, state: 'failed', error: error instanceof Error ? error.message : 'The import failed.' };
    }
    report();
  }

  return { added, rows: rows.map((row) => ({ ...row })) };
};
