/**
 * The artifact-index soft-delete / restore MUTATION, as a LEAF module.
 *
 * Why this file exists (T2.1, admin-latency): `admin-users` — one of the
 * three shell-trio functions, so it runs on EVERY admin navigation — needs
 * exactly one thing from the artifact-admin surface: soft-delete the blob
 * behind a removed member's avatar. It used to reach that through
 * `mcp-artifact-admin.ts`, which imports `functions/mcp.ts` back for
 * `toolError`/`toolResult`/`toNonEmptyString`, and mcp.ts is the ENTIRE MCP
 * tool surface (mcp-tool-handlers, object-validate, object-verbs, the PDF
 * render-data mapper, brand-imagery-proxy's `sharp` seam, the Stripe seam).
 * One 15-line mutation dragged ~2.4 MB of unrelated first-party source into
 * a cold start that the user waits on.
 *
 * So the mutation itself lives here, with NO MCP imports and no dependency on
 * the tool-result envelope: it returns a plain discriminated result and lets
 * each caller shape it. `mcp-artifact-admin.ts` still owns the MCP-facing
 * `soft_delete_artifact` / `restore_artifact` tools — the admin gate, the
 * `toolError`/`toolResult` envelope — and calls in here for the store work,
 * so there is exactly one copy of the business logic.
 *
 * Keep this module leaf. Its whole value is what it does NOT import; anything
 * added here is paid for on every admin page load. The bundle-cap test in
 * tests/netlify/function-bundle-budget.test.ts is what makes that stick.
 */
import { getArtifactIndexBlobStore } from './blob-store.js';
import { getMcpBinding } from './mcp-binding.js';
import { requestArtifactReferenceKey, type ArtifactIndexStore } from './artifact-index.js';
import {
  artifactReferenceLimits,
  isArtifactReference,
  isSafeArtifactText,
  type ArtifactReference,
} from './artifacts.js';
import type { SiteBinding } from './site-binding.js';

/** Local twin of mcp.ts's `toNonEmptyString`; importing it back would undo the whole point of this file. */
const trimmedOrUndefined = (value: unknown) => {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const normalizeArtifactSha256Input = (value: unknown) => {
  const sha256 = trimmedOrUndefined(value)?.toLowerCase();
  if (!sha256) return { ok: false as const, error: 'sha256 is required.' };
  if (!/^[a-f0-9]{64}$/.test(sha256)) return { ok: false as const, error: 'sha256 must be a 64-character hex digest.' };

  return { ok: true as const, sha256 };
};

export const normalizeDeletedByInput = (value: unknown, fallback: string) => {
  const deletedBy = trimmedOrUndefined(value) ?? fallback;

  if (!isSafeArtifactText(deletedBy, artifactReferenceLimits.label)) {
    return {
      ok: false as const,
      error: `deletedBy must be a safe string up to ${artifactReferenceLimits.label} characters.`,
    };
  }

  return { ok: true as const, deletedBy };
};

const parseJsonBlob = async (store: ArtifactIndexStore, key: string) => {
  const text = await store.get(key);
  if (!text) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export const loadArtifactReferenceForAdminMutation = async (
  store: ArtifactIndexStore,
  requestId: string,
  sha256: string
) => {
  const artifact = await parseJsonBlob(store, requestArtifactReferenceKey(requestId, sha256));

  if (!artifact) return { ok: false as const, error: 'Artifact reference was not found.' };
  if (!isArtifactReference(artifact)) return { ok: false as const, error: 'Artifact reference JSON is invalid.' };

  return { ok: true as const, artifact };
};

export const writeArtifactReferenceForAdminMutation = async (
  store: ArtifactIndexStore,
  requestId: string,
  artifact: ArtifactReference
) => {
  await store.setJSON(requestArtifactReferenceKey(requestId, artifact.sha256), artifact, {
    metadata: {
      requestId,
      sha256: artifact.sha256,
      contentType: artifact.contentType,
      ...(artifact.deletedAtISO ? { deletedAtISO: artifact.deletedAtISO } : {}),
    },
  });
};

export const openArtifactIndexStoreForAdminMutation = async (event: unknown, binding?: SiteBinding) =>
  (await getArtifactIndexBlobStore(event, binding ?? getMcpBinding())) as unknown as ArtifactIndexStore;

export type ArtifactMutationResult =
  | { ok: true; artifact: ArtifactReference; changed: boolean }
  | { ok: false; error: string };

/**
 * Stamp `deletedAtISO`/`deletedBy` on one artifact reference. Idempotent: an
 * already-deleted reference keeps its original stamp and is rewritten as-is.
 *
 * AUTHORIZATION IS THE CALLER'S JOB. Both callers today authenticate an admin
 * BEFORE they get here (mcp-artifact-admin's `requireAdminToolAccess`;
 * admin-users' own `roles.includes('admin')` gate), and neither reaches this
 * function otherwise.
 */
export const softDeleteArtifactReference = async (
  event: unknown,
  input: { requestId: unknown; sha256: unknown; deletedBy: unknown; deletedByFallback: string },
  binding?: SiteBinding
): Promise<ArtifactMutationResult> => {
  const requestId = trimmedOrUndefined(input.requestId);
  if (!requestId) return { ok: false, error: 'requestId is required.' };

  const sha256 = normalizeArtifactSha256Input(input.sha256);
  if (!sha256.ok) return { ok: false, error: sha256.error };

  const deletedBy = normalizeDeletedByInput(input.deletedBy, input.deletedByFallback);
  if (!deletedBy.ok) return { ok: false, error: deletedBy.error };

  const store = await openArtifactIndexStoreForAdminMutation(event, binding);
  const loaded = await loadArtifactReferenceForAdminMutation(store, requestId, sha256.sha256);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const deletedArtifact: ArtifactReference = {
    ...loaded.artifact,
    deletedAtISO: loaded.artifact.deletedAtISO ?? new Date().toISOString(),
    deletedBy: loaded.artifact.deletedBy ?? deletedBy.deletedBy,
  };

  await writeArtifactReferenceForAdminMutation(store, requestId, deletedArtifact);

  return { ok: true, artifact: deletedArtifact, changed: true };
};

/** Clear `deletedAtISO`/`deletedBy`. `changed` is false when the reference was not deleted to begin with. */
export const restoreArtifactReference = async (
  event: unknown,
  input: { requestId: unknown; sha256: unknown },
  binding?: SiteBinding
): Promise<ArtifactMutationResult> => {
  const requestId = trimmedOrUndefined(input.requestId);
  if (!requestId) return { ok: false, error: 'requestId is required.' };

  const sha256 = normalizeArtifactSha256Input(input.sha256);
  if (!sha256.ok) return { ok: false, error: sha256.error };

  const store = await openArtifactIndexStoreForAdminMutation(event, binding);
  const loaded = await loadArtifactReferenceForAdminMutation(store, requestId, sha256.sha256);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const { deletedAtISO, deletedBy, ...restoredArtifact } = loaded.artifact;
  await writeArtifactReferenceForAdminMutation(store, requestId, restoredArtifact);

  return { ok: true, artifact: restoredArtifact, changed: Boolean(deletedAtISO || deletedBy) };
};
