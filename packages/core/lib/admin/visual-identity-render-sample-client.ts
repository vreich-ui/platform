/**
 * Browser client for the deterministic PDF sample render (A5).
 *
 * The PDF templates tab's "Render sample" button calls
 * `admin-visual-identity-render-sample` directly — the endpoint reads the
 * template's own sampleData, mints its own throwaway request id, and calls
 * `create_agent_artifact_job` itself. The browser sends the template id and
 * nothing else.
 */
const ENDPOINT = '/.netlify/functions/admin-visual-identity-render-sample';

export type RenderSampleResponse = {
  templateId: string;
  requestId?: string;
  jobId?: string;
  artifactReference?: Record<string, unknown>;
  publicPath?: string;
  verified?: boolean;
  /**
   * W5 F7: true when the endpoint answered 202 — the render job was created
   * and is still running past `create_agent_artifact_job`'s inline-wait
   * budget. There is no artifact yet, so the caller must WAIT rather than
   * announce a rendered sample (and must not simply call again: a second call
   * mints a second request id and pays for a second render).
   */
  pending: boolean;
};

export type RenderSampleInput = {
  templateId: string;
};

type Fetcher = typeof fetch;

export const renderPdfTemplateSample = async (
  getToken: () => Promise<string>,
  input: RenderSampleInput,
  fetchImpl: Fetcher = fetch
): Promise<RenderSampleResponse> => {
  const token = await getToken();
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ templateId: input.templateId }),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<{
    template_id: string;
    request_id: string;
    jobId: string;
    artifactReference: Record<string, unknown>;
    public_path: string;
    verified: boolean;
    error: string;
  }>;
  if (!response.ok) throw new Error(body.error || `The sample could not be rendered (${response.status}).`);
  return {
    pending: response.status === 202 || !body.artifactReference,
    templateId: body.template_id ?? input.templateId,
    ...(body.request_id ? { requestId: body.request_id } : {}),
    ...(body.jobId ? { jobId: body.jobId } : {}),
    ...(body.artifactReference ? { artifactReference: body.artifactReference } : {}),
    ...(body.public_path ? { publicPath: body.public_path } : {}),
    ...(body.verified !== undefined ? { verified: body.verified } : {}),
  };
};
