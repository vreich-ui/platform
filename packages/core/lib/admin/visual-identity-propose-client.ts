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
import { parseBlockage, type Blockage } from './blockage.js';

const ENDPOINT = '/.netlify/functions/admin-visual-identity-propose';

/**
 * F5, the LAST flattening on this path. `throw new Error(body.error)` turned a
 * response that already carried `error_code` and (after blockage.v1) the whole
 * remedy into a bare sentence, which `ImageryBoard` then stored as
 * `error: string` and rendered under a red X. The card cannot show a button it
 * was never handed, so it showed prose naming a raise nobody could click.
 *
 * Everything the server said now survives the throw. Nothing else about the
 * call changed: `.message` is the same sentence it always was, so any caller
 * that only ever read that still reads it.
 */
export class VisualIdentityProposeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly blockage?: Blockage;
  /** CMS-Agent's own English remedy sentence — shown when there is no blockage (an older engine). */
  readonly operatorAction?: string;

  constructor(message: string, options: { code: string; status: number; blockage?: Blockage; operatorAction?: string }) {
    super(message);
    this.name = 'VisualIdentityProposeError';
    this.code = options.code;
    this.status = options.status;
    if (options.blockage) this.blockage = options.blockage;
    if (options.operatorAction) this.operatorAction = options.operatorAction;
  }
}

/**
 * D3 — what "Raise to $1.50 for this attempt" actually sends: the same propose
 * call again, naming the wall and the remedy the engine offered. The server
 * decides what that means (a one-shot ceiling, or an Owner-gated default write
 * first) — the browser never names a budget the engine did not.
 */
export type ProposeRemedyInput = {
  blockage_id: string;
  remedy_id: string;
  scope: 'attempt' | 'default';
  budget_usd: number;
};

export type ProposeContractResponse = {
  standardId: string;
  mode: 'house' | 'template';
  /** The WHOLE mood board — the denominator "N of M reached the writer" reads. */
  referencesTotal: number;
  /** How many of them were sent at all (the writer's own 8-image ceiling). */
  referencesSent: number;
  referencesResolved: number;
  /** `image_dropped:<ref_id>` per reference that could not reach the writer, plus
   *  `references_truncated:<sent>_of_<total>` when the board is over the ceiling. */
  warnings: string[];
  proposal: Record<string, unknown>;
};

export type ProposeContractInput = {
  standardId: string;
  brief?: string;
  /** Present only when this call is a blockage resolution (a re-propose). */
  remedy?: ProposeRemedyInput;
  /**
   * D6 — the Publishing Agent panel's chat, so a run started from this BUTTON
   * shows up in the transcript beside it (a note, and the same blockage card
   * with the same remedies). Absent, the endpoint writes no chat events at all
   * and behaves exactly as it did before.
   */
  chatId?: string;
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
      ...(input.remedy ? { remedy: input.remedy } : {}),
      ...(input.chatId ? { chat_id: input.chatId } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<{
    standard_id: string;
    mode: 'house' | 'template';
    references_total: number;
    references_sent: number;
    references_resolved: number;
    warnings: string[];
    proposal: Record<string, unknown>;
    error: string;
    error_code: string;
    blockage: unknown;
    operatorAction: string;
  }>;
  if (!response.ok) {
    throw new VisualIdentityProposeError(body.error || `The contract could not be proposed (${response.status}).`, {
      code: body.error_code || 'propose_failed',
      status: response.status,
      // Validated, not trusted: `parseBlockage` drops a remedy this build has
      // no handler for rather than letting a dead button reach the card.
      ...(parseBlockage(body.blockage) ? { blockage: parseBlockage(body.blockage)! } : {}),
      ...(typeof body.operatorAction === 'string' && body.operatorAction ? { operatorAction: body.operatorAction } : {}),
    });
  }
  return {
    standardId: body.standard_id ?? input.standardId,
    mode: body.mode ?? 'template',
    referencesTotal: typeof body.references_total === 'number' ? body.references_total : 0,
    referencesSent:
      typeof body.references_sent === 'number'
        ? body.references_sent
        : typeof body.references_total === 'number'
          ? body.references_total
          : 0,
    referencesResolved: typeof body.references_resolved === 'number' ? body.references_resolved : 0,
    warnings: Array.isArray(body.warnings) ? body.warnings : [],
    proposal: body.proposal ?? {},
  };
};

/** "N of M references reached the writer" — the exact line the proposal card shows. */
export const referencesReachedWriterLabel = (input: { referencesTotal: number; referencesResolved: number }): string =>
  `${input.referencesResolved} of ${input.referencesTotal} reference${input.referencesTotal === 1 ? '' : 's'} reached the writer`;

// ─── accepting a proposal (W5 F2) ────────────────────────────────────────────

/**
 * THE GAP THIS CLOSES. A3 turned "Write contract from mood board" into an
 * endpoint that RETURNS a `brand_imagery_proposal.v1` — and nothing wrote it
 * anywhere. CMS-Agent's `visual_identity_propose` is explicitly read-only
 * ("no object is created, patched, applied or published"), `proposeBrandImagery`
 * writes nothing, and the card the tab rendered had no action on it, so the
 * proposal died on a page reload and "Make this the site's imagery" went on
 * applying the standard's OLD contract. The chat instruction it replaced ended
 * with the agent writing the accepted contract onto the standard; this is that
 * step, deterministically.
 *
 * It is an ORDINARY `set_visual_standard_fields` patch — the same op the mood
 * board already saves with, over fields that are ordinary agent/human-writable
 * on a visual_standard (object-patch-ops.ts's own note: the governed copy is
 * the SITE's applied `brandImagery`, not this draft). So accepting needs no
 * new endpoint and no privileged funnel: it runs through `admin-object.ts`
 * like every other board write, which also means A6's example generator is
 * triggered by it for free — a new contract is exactly when examples are stale.
 *
 * Returns undefined when the payload is not a proposal this can accept
 * (no `brandImagery`, or no `label` to name it by) rather than writing a
 * half-contract.
 */
export type AcceptProposalOp = {
  op: 'set_visual_standard_fields';
  fields: Record<string, unknown>;
};

export const buildAcceptProposalOp = (proposal: unknown): AcceptProposalOp | undefined => {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return undefined;
  const record = proposal as Record<string, unknown>;
  const brandImagery = record.brandImagery;
  if (!brandImagery || typeof brandImagery !== 'object' || Array.isArray(brandImagery)) return undefined;
  const label = typeof record.label === 'string' && record.label.trim().length > 0 ? record.label.trim() : undefined;
  if (!label) return undefined;
  const sampleSubjects = Array.isArray(record.sampleSubjects)
    ? record.sampleSubjects.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const whenToUse =
    typeof record.whenToUse === 'string' && record.whenToUse.trim().length > 0 ? record.whenToUse.trim() : undefined;
  return {
    op: 'set_visual_standard_fields',
    fields: {
      brandImagery,
      label,
      // Never write an EMPTY sampleSubjects[]: a published standard's own
      // schema invariant requires at least one, and clearing them would be a
      // silent downgrade of a standard that already had some.
      ...(sampleSubjects.length > 0 ? { sampleSubjects } : {}),
      ...(whenToUse ? { whenToUse } : {}),
    },
  };
};
