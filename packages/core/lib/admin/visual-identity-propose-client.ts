/**
 * Browser client for the deterministic contract propose (A3).
 *
 * The Imagery tab's "Write contract from mood board" button calls
 * `admin-visual-identity-propose` directly instead of building a chat
 * instruction (`buildProposeContractIntent`, visual-identity-imagery.ts,
 * kept as the fallback the docked rail still understands). The endpoint
 * resolves the standard's OWN mood board to base64 server-side and calls
 * `visual_identity_propose` itself, so the browser sends only the standard
 * id and an optional brief.
 */
const ENDPOINT = '/.netlify/functions/admin-visual-identity-propose';

export type ProposeContractResponse = {
  standardId: string;
  mode: 'house' | 'template';
  referencesTotal: number;
  referencesResolved: number;
  /** `image_dropped:<ref_id>` for every reference that could not reach the writer. */
  warnings: string[];
  proposal: Record<string, unknown>;
};

export type ProposeContractInput = {
  standardId: string;
  brief?: string;
};

type Fetcher = typeof fetch;

export const proposeVisualIdentityContract = async (
  getToken: () => Promise<string>,
  input: ProposeContractInput,
  fetchImpl: Fetcher = fetch
): Promise<ProposeContractResponse> => {
  const token = await getToken();
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      standardId: input.standardId,
      ...(input.brief?.trim() ? { brief: input.brief.trim() } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<{
    standard_id: string;
    mode: 'house' | 'template';
    references_total: number;
    references_resolved: number;
    warnings: string[];
    proposal: Record<string, unknown>;
    error: string;
  }>;
  if (!response.ok) throw new Error(body.error || `The contract could not be proposed (${response.status}).`);
  return {
    standardId: body.standard_id ?? input.standardId,
    mode: body.mode ?? 'template',
    referencesTotal: typeof body.references_total === 'number' ? body.references_total : 0,
    referencesResolved: typeof body.references_resolved === 'number' ? body.references_resolved : 0,
    warnings: Array.isArray(body.warnings) ? body.warnings : [],
    proposal: body.proposal ?? {},
  };
};

/** "N of M references reached the writer" — the exact line the proposal card shows. */
export const referencesReachedWriterLabel = (input: { referencesTotal: number; referencesResolved: number }): string =>
  `${input.referencesResolved} of ${input.referencesTotal} reference${input.referencesTotal === 1 ? '' : 's'} reached the writer`;
