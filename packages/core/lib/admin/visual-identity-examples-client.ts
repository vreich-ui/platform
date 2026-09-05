/**
 * Browser client for kicking A6's example-generation job on demand (A5).
 *
 * The Imagery tab's "Regenerate examples" button calls
 * `admin-visual-identity-regenerate-examples` directly instead of the
 * `set_visual_standard_fields` chat instruction
 * (`buildRegenerateExamplesIntent`, visual-identity-imagery.ts, R9/X1) — the
 * endpoint clears the standard's stale `examples[]` under an ordinary
 * checkout and then triggers the SAME background job
 * (`visual-standard-examples-jobs.ts`, A6) the mood-board save and
 * "Make this the site's imagery" already trigger. It never generates
 * inline — the response is the job's `pending`/`partial`/`ready`/`failed`
 * status, not a finished result.
 */
const ENDPOINT = '/.netlify/functions/admin-visual-identity-regenerate-examples';

export type ExamplesJobContextView = {
  usageContext: string;
  status: string;
  blobKey?: string;
};

export type ExamplesJobView = {
  status: 'pending' | 'partial' | 'ready' | 'failed';
  contexts: ExamplesJobContextView[];
  trigger: 'mcp' | 'browser';
  reason?: string;
  dispatched?: boolean;
  startedAt: string;
  updatedAt: string;
};

export type RegenerateExamplesResponse = {
  standardId: string;
  job?: ExamplesJobView;
};

export type RegenerateExamplesInput = {
  standardId: string;
};

type Fetcher = typeof fetch;

/** The wire shape `examplesJobStatusView` (server-side, `visual-standard-examples-jobs.ts`)
 *  produces — shared by BOTH call sites A7 reads it from: this endpoint's own
 *  response, and the `examples_job` field `admin-object.ts` decorates a
 *  `visual_standard` `get` with. One parser for both keeps them from ever
 *  drifting into two shapes for the same record. */
type ExamplesJobWire = Partial<{
  examples_status: ExamplesJobView['status'];
  contexts: ExamplesJobContextView[];
  trigger: ExamplesJobView['trigger'];
  reason?: string;
  dispatched?: boolean;
  started_at: string;
  updated_at: string;
}>;

export const parseExamplesJobView = (raw: unknown): ExamplesJobView | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const job = raw as ExamplesJobWire;
  if (!job.examples_status) return undefined;
  return {
    status: job.examples_status,
    contexts: Array.isArray(job.contexts) ? job.contexts : [],
    trigger: job.trigger as ExamplesJobView['trigger'],
    ...(job.reason ? { reason: job.reason } : {}),
    ...(job.dispatched !== undefined ? { dispatched: job.dispatched } : {}),
    startedAt: job.started_at as string,
    updatedAt: job.updated_at as string,
  };
};

export const regenerateVisualStandardExamples = async (
  getToken: () => Promise<string>,
  input: RegenerateExamplesInput,
  fetchImpl: Fetcher = fetch
): Promise<RegenerateExamplesResponse> => {
  const token = await getToken();
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ standardId: input.standardId }),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<{
    standard_id: string;
    examples_job: ExamplesJobWire;
    error: string;
  }>;
  if (!response.ok) throw new Error(body.error || `The examples could not be regenerated (${response.status}).`);
  const job = parseExamplesJobView(body.examples_job);
  return {
    standardId: body.standard_id ?? input.standardId,
    ...(job ? { job } : {}),
  };
};
