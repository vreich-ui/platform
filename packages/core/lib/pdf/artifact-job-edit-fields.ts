/**
 * S1/Task A — the five EDIT fields of `create_agent_artifact_job`, mapped
 * from this bridge's snake_case tool input onto pdf-tool's camelCase job
 * input.
 *
 * THE DEFECT THIS CLOSES. pdf-tool takes `operation:"edit"` together with
 * `sourceArtifact` ({artifactReference, expectedSha256}), `editMode`
 * (deterministic_transform | masked_edit | image_variation |
 * template_data_patch | pdf_overlay | pdf_transform), and optionally
 * `maskRef` and `editInstructions` — all five TOP-LEVEL on the job input.
 * Platform's bridge declared only `operation` and dropped the other four on
 * the floor: mcp-tool-handlers.ts's `jobInput` never mentioned them and
 * pdf-tool-client.ts's `createPlatformArtifactJob` had no slot to put them
 * in. Because the bridge's published input schema is not enforced as a hard
 * reject on the wire, a caller passing them top-level got NO "unknown field"
 * complaint — the call was accepted, the fields were discarded, and pdf-tool
 * then failed the job with "edit jobs require sourceArtifact.artifactReference;
 * … expectedSha256; … editMode". Reproduced live on site_platform 2026-09-08
 * with sourceArtifact + editMode supplied top-level: identical error, while
 * the DECLARED field supplied in the same call (`prompt`) did take effect —
 * proof the input reached the handler and only these fields were lost. Under
 * `requirements` it failed identically, because that is not where pdf-tool
 * reads them from either.
 *
 * WHAT THIS MODULE DOES, AND DELIBERATELY DOES NOT DO. It maps and forwards.
 * It does not re-validate pdf-tool's own contract: `editMode`'s enum,
 * `sourceArtifact`'s required members and `expectedSha256`'s shape are
 * pdf-tool's to enforce, and its typed errors already name the offending
 * field precisely (that is exactly the message quoted above). A second,
 * divergent copy of that validation living here is how the two sides drift.
 * What it DOES refuse to forward is a value of the wrong JSON SHAPE (a
 * string where pdf-tool's schema declares an object, an empty string where it
 * declares a non-empty one), which would otherwise turn a caller's typo into
 * a schema rejection of the whole payload rather than a field-named error.
 *
 * PURE. No I/O, no bridge state — takes the raw tool input, returns the
 * fields to spread onto the pdf-tool job input.
 */

/** pdf-tool's declared edit modes, for callers that want to name them. */
export const PDF_TOOL_EDIT_MODES = [
  'deterministic_transform',
  'masked_edit',
  'image_variation',
  'template_data_patch',
  'pdf_overlay',
  'pdf_transform',
] as const;

export type PdfToolEditMode = (typeof PDF_TOOL_EDIT_MODES)[number];

export interface ArtifactJobEditFields {
  operation?: 'generate' | 'edit';
  sourceArtifact?: Record<string, unknown>;
  editMode?: string;
  maskRef?: Record<string, unknown>;
  editInstructions?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Accepts an object, or a JSON string that parses to one. The string form
 * exists because an MCP client whose own schema does not declare these fields
 * will often stringify a nested object rather than send it structurally — the
 * exact thing the live reproduction had to do. A string that is not JSON, or
 * that parses to a non-object, is dropped rather than forwarded as garbage.
 */
const toObjectField = (value: unknown): Record<string, unknown> | undefined => {
  if (isRecord(value)) return value;
  const text = toNonEmptyString(value);
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Maps `create_agent_artifact_job`'s edit-related tool input onto the
 * pdf-tool job input's own top-level field names. All five names are
 * identical on both sides (pdf-tool uses camelCase and so do these), so this
 * is a shape-check and a pass-through, not a rename.
 *
 * `operation` is normalized to pdf-tool's enum; anything else is dropped so
 * pdf-tool applies its own documented default of "generate" rather than being
 * handed a value its schema rejects.
 */
export const resolveArtifactJobEditFields = (input: Record<string, unknown>): ArtifactJobEditFields => {
  const operationRaw = toNonEmptyString(input.operation);
  const operation = operationRaw === 'edit' || operationRaw === 'generate' ? operationRaw : undefined;

  const sourceArtifact = toObjectField(input.sourceArtifact);
  const editMode = toNonEmptyString(input.editMode);
  const maskRef = toObjectField(input.maskRef);
  const editInstructions = toObjectField(input.editInstructions);

  return {
    ...(operation ? { operation } : {}),
    ...(sourceArtifact ? { sourceArtifact } : {}),
    ...(editMode ? { editMode } : {}),
    ...(maskRef ? { maskRef } : {}),
    ...(editInstructions ? { editInstructions } : {}),
  };
};
