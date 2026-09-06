/**
 * Browser client for the direct PDF first-page preview (A5).
 *
 * The PDF templates tab's "Render sample (first page only)" chip calls
 * `admin-visual-identity-preview-sample` directly instead of the
 * `preview_pdf_template` chat instruction (`buildPreviewSampleIntent`,
 * visual-identity-pdf.ts, T2.6) — the endpoint reads the template's own
 * sampleData and calls pdf-tool's `preview_pdf_template` itself. The browser
 * sends the template id and nothing else. `previewUrl` is present only when
 * the endpoint could compute a servable one; the raw pdf-tool response
 * always rides along in `raw` so nothing this endpoint could not name is
 * silently dropped.
 */
const ENDPOINT = '/.netlify/functions/admin-visual-identity-preview-sample';

export type PreviewSampleResponse = {
  templateId: string;
  previewUrl?: string;
  raw: Record<string, unknown>;
};

export type PreviewSampleInput = {
  templateId: string;
};

type Fetcher = typeof fetch;

export const previewPdfTemplateSample = async (
  getToken: () => Promise<string>,
  input: PreviewSampleInput,
  fetchImpl: Fetcher = fetch
): Promise<PreviewSampleResponse> => {
  const token = await getToken();
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ templateId: input.templateId }),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<{
    template_id: string;
    preview_url: string;
    error: string;
  }> &
    Record<string, unknown>;
  if (!response.ok) throw new Error((body.error as string) || `The preview could not be rendered (${response.status}).`);
  // `ok`/`status` are the envelope every admin endpoint answers with; they are
  // stripped here so `raw` is only what pdf-tool itself returned.
  const { template_id, preview_url, ok: _ok, status: _status, ...raw } = body;
  return {
    templateId: (template_id as string) ?? input.templateId,
    ...(preview_url ? { previewUrl: preview_url } : {}),
    raw: raw as Record<string, unknown>,
  };
};
