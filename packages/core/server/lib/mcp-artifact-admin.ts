/**
 * Admin/migration artifact tooling: index browsing, search, soft-delete /
 * restore, blob-store wipe, and legacy request-artifacts-JSON reconciliation
 * (list_artifacts_for_request through reconcile_artifact_indexes).
 *
 * Split out of mcp.ts (W14 T14.3 delete_pdf_template bridge follow-up) purely
 * to keep each source file within the GitHub content-push size this repo's
 * tooling can deliver in one shot -- NOT a behavioral seam; mcp.ts imports
 * and dispatches to these exactly as it did when they lived inline. A few
 * names it references (toolError, toolResult, toNonEmptyString,
 * getRecordValue, hasValidNetlifyPublishSecret, and the LambdaEvent type)
 * are imported back from mcp.ts -- a real circular import, but a safe one:
 * every one of those bindings is only read inside an async function body
 * here, never at this module's own top level, so it is always fully
 * initialized by the time any of these functions actually runs (module
 * evaluation completes for both files before either's exported functions
 * are invoked by a real request).
 */
import {
  getArtifactBlobStore,
  getArtifactIndexBlobStore,
  getWorkflowBlobStore,
} from './blob-store.js';
import { collectBlobListItems } from './blob-list.js';
import {
  listArtifactIndexKeys,
  listArtifactReferencesForRequest,
  readArtifactReference,
  requestArtifactReferenceKey,
  resolveArtifactPointer,
  writeArtifactReferenceIndexes,
  type ArtifactIndexStore,
} from './artifact-index.js';
import {
  artifactKindValues,
  artifactReferenceLimits,
  isArtifactReference,
  isDeletedArtifactReference,
  isSafeArtifactText,
  normalizeArtifactBlobKey,
  reconcileArtifactReference,
  safePathSegment,
  type ArtifactReference,
} from './artifacts.js';
import { validateRequestId } from '../../lib/agents-naming.js';
import { getAdminStateFromEvent } from './admin-auth.js';
import { resolveAdminAccessFromEvent } from './request-roles.js';

import {
  ARTIFACT_LIST_DEFAULT_LIMIT,
  ARTIFACT_LIST_MAX_LIMIT,
  WIPE_BLOB_CONFIRMATION,
} from './mcp-tool-definitions.js';
import {
  getRecordValue,
  hasValidNetlifyPublishSecret,
  toNonEmptyString,
  toolError,
  toolResult,
  type LambdaEvent,
} from '../functions/mcp.js';

// Relocated from mcp.ts's core-types section (W14 T14.3 follow-up split):
// used only here.
const WIPE_BLOB_SAMPLE_LIMIT = 20;

type ArtifactBlobStore = Awaited<ReturnType<typeof getArtifactBlobStore>>;

type ArtifactBrowseOptions = {
  createdAfter?: Date;
  createdBefore?: Date;
  cursor: number;
  includeDeleted: boolean;
  limit: number;
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

const loadArtifactIndexKeysFromPrefix = async (store: ArtifactIndexStore, prefix: string, limit: number) => {
  const keys = await listArtifactIndexKeys(store, prefix);

  return keys.slice(0, limit);
};

const normalizeArtifactReconcileLimit = (limit: unknown) => {
  if (limit === undefined || limit === null) return { ok: true as const, value: ARTIFACT_LIST_DEFAULT_LIMIT };
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > ARTIFACT_LIST_MAX_LIMIT) {
    return { ok: false as const, error: `limit must be an integer from 1 to ${ARTIFACT_LIST_MAX_LIMIT}.` };
  }

  return { ok: true as const, value: limit as number };
};

const normalizeIndexedArtifactReference = (value: unknown) => {
  const record = getRecordValue(value);
  const originalBlobKey = toNonEmptyString(record?.blobKey);
  if (!record || !originalBlobKey) return undefined;

  const normalized = { ...record, blobKey: normalizeArtifactBlobKey(originalBlobKey) };
  if (!isArtifactReference(normalized)) return undefined;

  return { originalBlobKey, reference: { ...normalized, blobKey: originalBlobKey } as ArtifactReference };
};

const getArtifactKindFromBlobKey = (blobKey: string) => normalizeArtifactBlobKey(blobKey).split('/')[0] || '';

const summarizeArtifactReconciliation = (
  indexKey: string,
  reference: ArtifactReference,
  result: Awaited<ReturnType<typeof reconcileArtifactReference>>
) => ({
  indexKey,
  sha256: reference.sha256,
  previousBlobKey: reference.blobKey,
  status: result.status,
  blobKey: result.blobKey,
  ...(result.status === 'found' && result.correctedBlobKey ? { correctedBlobKey: result.correctedBlobKey } : {}),
  ...(result.status === 'missing'
    ? { exactFilenameExists: result.exactFilenameExists, nearbyCount: result.nearbyKeys.length }
    : {}),
  ...(result.status === 'ambiguous' ? { matchingKeys: result.matchingKeys } : {}),
});

type ArtifactReconciliationSummary = ReturnType<typeof summarizeArtifactReconciliation>;

const reconcileArtifactIndexKeys = async (
  artifactStore: ArtifactBlobStore,
  indexStore: ArtifactIndexStore,
  keys: string[],
  artifactKind?: string
) => {
  const results: ArtifactReconciliationSummary[] = [];
  let skipped = 0;

  for (const indexKey of keys) {
    const normalized = normalizeIndexedArtifactReference(await parseJsonBlob(indexStore, indexKey));
    if (!normalized) {
      skipped += 1;
      continue;
    }

    if (artifactKind && getArtifactKindFromBlobKey(normalized.reference.blobKey) !== artifactKind) {
      skipped += 1;
      continue;
    }

    const result = await reconcileArtifactReference(normalized.reference, artifactStore, indexStore, {
      logger: console,
    });
    results.push(summarizeArtifactReconciliation(indexKey, normalized.reference, result));
  }

  return { results, skipped };
};

const normalizeArtifactBrowseLimit = (limit: unknown) => {
  if (limit === undefined || limit === null) return { ok: true as const, value: ARTIFACT_LIST_DEFAULT_LIMIT };
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > ARTIFACT_LIST_MAX_LIMIT) {
    return { ok: false as const, error: `limit must be an integer from 1 to ${ARTIFACT_LIST_MAX_LIMIT}.` };
  }

  return { ok: true as const, value: limit as number };
};

const normalizeArtifactBrowseCursor = (cursor: unknown) => {
  if (cursor === undefined || cursor === null || cursor === '') return { ok: true as const, value: 0 };
  if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) {
    return { ok: false as const, error: 'cursor must be a cursor string returned by a previous artifact list call.' };
  }

  return { ok: true as const, value: Number(cursor) };
};

const normalizeArtifactBrowseOptions = (
  input: Record<string, unknown>
): ArtifactBrowseOptions | ReturnType<typeof toolError> => {
  const limit = normalizeArtifactBrowseLimit(input.limit);
  if (!limit.ok) return toolError(limit.error);

  const cursor = normalizeArtifactBrowseCursor(input.cursor);
  if (!cursor.ok) return toolError(cursor.error);

  const createdAfter = input.createdAfter === undefined ? undefined : new Date(String(input.createdAfter));
  if (createdAfter && Number.isNaN(createdAfter.getTime()))
    return toolError('createdAfter must be a valid ISO date string.');

  const createdBefore = input.createdBefore === undefined ? undefined : new Date(String(input.createdBefore));
  if (createdBefore && Number.isNaN(createdBefore.getTime())) {
    return toolError('createdBefore must be a valid ISO date string.');
  }

  return {
    limit: limit.value,
    cursor: cursor.value,
    includeDeleted: input.includeDeleted === true,
    createdAfter,
    createdBefore,
  };
};

const isArtifactBrowseOptions = (
  value: ArtifactBrowseOptions | ReturnType<typeof toolError>
): value is ArtifactBrowseOptions => !('isError' in value);

const paginateArtifacts = (artifacts: unknown[], limit: number, cursor: number) => {
  const page = artifacts.slice(cursor, cursor + limit);
  const nextOffset = cursor + page.length;

  return {
    artifacts: page,
    limit,
    cursor: String(cursor),
    nextCursor: nextOffset < artifacts.length ? String(nextOffset) : null,
  };
};

const getArtifactCreatedAtMs = (artifact: unknown) => {
  const value = getRecordValue(artifact);
  const createdAtISO = toNonEmptyString(value?.createdAtISO);

  return createdAtISO ? Date.parse(createdAtISO) : Number.NaN;
};

const filterArtifactsForBrowse = (artifacts: unknown[], options: ArtifactBrowseOptions) => {
  const visibleArtifacts = options.includeDeleted
    ? artifacts
    : artifacts.filter((artifact) => !isDeletedArtifactReference(artifact));

  if (!options.createdAfter && !options.createdBefore) return visibleArtifacts;

  const afterMs = options.createdAfter?.getTime() ?? Number.NEGATIVE_INFINITY;
  const beforeMs = options.createdBefore?.getTime() ?? Number.POSITIVE_INFINITY;

  return visibleArtifacts.filter((artifact) => {
    const createdAtMs = getArtifactCreatedAtMs(artifact);

    return Number.isFinite(createdAtMs) && createdAtMs >= afterMs && createdAtMs <= beforeMs;
  });
};

const listArtifactsFromPointerPrefixes = async (
  event: LambdaEvent,
  prefixes: string[],
  options: ArtifactBrowseOptions
) => {
  const store = (await getArtifactIndexBlobStore(event)) as unknown as ArtifactIndexStore;
  const pointerKeys: string[] = [];

  for (const prefix of prefixes) {
    pointerKeys.push(...(await listArtifactIndexKeys(store, prefix)));
  }

  const uniquePointerKeys = [...new Set(pointerKeys)].sort();
  const artifacts = await Promise.all(
    uniquePointerKeys.map(async (key) => resolveArtifactPointer(store, await parseJsonBlob(store, key)))
  );
  const filteredArtifacts = filterArtifactsForBrowse(
    artifacts.filter((artifact) => artifact !== undefined),
    options
  );

  return toolResult(paginateArtifacts(filteredArtifacts, options.limit, options.cursor));
};

const getAdminToolState = async (event: LambdaEvent) => {
  const adminState = await getAdminStateFromEvent(event);

  if (!adminState.authenticated) {
    return toolError(
      adminState.error || 'A valid admin session token is required.',
      { error_code: 'admin_required' }
    );
  }
  if (!adminState.isAdmin) {
    return toolError('This user is not authorized to browse artifacts.', { error_code: 'admin_required' });
  }

  return adminState;
};

/**
 * Gate for the genuinely destructive/migration admin tools
 * (soft_delete_artifact, restore_artifact, migrate_artifact_indexes,
 * reconcile_artifact_indexes — all hidden from MCP discovery via
 * INTERNAL_ONLY_TOOLS in mcp.ts). These stay ADMIN-ONLY: Wolf's 2026-08-10
 * ruling on KNOWN_ISSUES #2 chose Option B (fix the gate so it fails
 * correctly) over Option A (widen them to any MCP-authenticated caller the
 * way the three read-only browse tools below were widened). Do not add an
 * `event.mcpGateAuthenticated` bypass here.
 *
 * What was broken (QA-W16-3): this gate never failed OPEN, it failed WRONG.
 * It resolved authority exclusively from a role source that does not exist on
 * the MCP path — `getAdminStateFromEvent`, called with no Lambda `context`,
 * so its `clientContext.user` branch is unreachable and it always falls
 * through to verifying the caller's bearer token against
 * `${IDENTITY_URL}/user`. An MCP caller's bearer is the shared
 * MCP_HTTP_AUTH_TOKEN, a verified per-agent token, or an OAuth access token —
 * never a GoTrue session token — so that round trip 401s every time and the
 * caller got `Authentication token could not be verified.`, i.e. "your MCP
 * credentials are invalid" when in fact they were valid and merely not
 * admin. Two consequences fixed here:
 *   1. An MCP-gated caller is refused up front, without the doomed identity
 *      round trip, with a message that says exactly why (admin-only) instead
 *      of impersonating a credential failure.
 *   2. The human path now resolves through `resolveAdminAccessFromEvent` —
 *      the W15 S1 single admin resolver (ADMIN_EMAILS bootstrap owners ∪ the
 *      users-store tier) — instead of `getAdminStateFromEvent`'s older
 *      ADMIN_EMAILS-only `isAdmin`, which wrongly denied an admin granted the
 *      tier by store invite.
 * Every path still fails closed; only the publish secret and a real admin
 * session pass. If an agent tier ever needs these verbs, that is a new,
 * explicit grant added here — not the absence of a check.
 */
const requireAdminToolAccess = async (event: LambdaEvent) => {
  if (hasValidNetlifyPublishSecret(event)) return undefined;

  if (event.mcpGateAuthenticated) {
    return toolError(
      'This tool is admin-only. Your MCP credentials are valid, but destructive and index-migration artifact tools require the server publish secret or a Netlify Identity admin session.',
      { error_code: 'admin_required' }
    );
  }

  const access = await resolveAdminAccessFromEvent(event);
  if (access.authenticated && access.isAdmin) return undefined;

  return toolError(
    access.authenticated
      ? 'This user is not authorized to administer artifacts.'
      : access.error || 'A valid admin session token is required.',
    { error_code: 'admin_required' }
  );
};

/**
 * QA-W16-3 (live QA, 2026-08-06): `list_artifacts_by_kind`,
 * `list_artifacts_by_request`, and `search_artifacts` are documented
 * "admin-only" and ARE listed in MCP tool discovery (unlike their
 * destructive/migration siblings above, which are deliberately hidden via
 * INTERNAL_ONLY_TOOLS) — but until this fix, calling any of them failed
 * EVERY time with "Authentication token could not be verified.", 100%
 * reproducible, while sibling tools get_artifact_metadata and
 * list_artifacts_for_request worked fine with the identical MCP credentials.
 *
 * Root cause: nothing in this codebase ever calls these three functions from
 * a browser request carrying a real Netlify Identity session — they are
 * dispatched EXCLUSIVELY through mcp.ts's callTool. `getAdminToolState`
 * (still the human-session path here) unconditionally tries to verify
 * the caller's Authorization bearer token as a Netlify Identity/GoTrue
 * session token. Every MCP caller's bearer token is the shared
 * MCP_HTTP_AUTH_TOKEN or a verified per-agent token — never a GoTrue token —
 * so that verification call to `${IDENTITY_URL}/user` failed 100% of the
 * time, and the caller saw a generic broken-token message indistinguishable
 * from an actually-invalid credential.
 *
 * Fix, scoped to exactly these three tools: a request that reached this
 * function has ALREADY cleared the platform's own MCP authentication gate
 * (`event.mcpGateAuthenticated`, set once per request in mcp.ts's handler
 * right after `getAuthResult` succeeds) — the same guarantee their working
 * siblings already rely on with no extra check at all. That is accepted
 * here too. A real Netlify Identity admin session remains a second valid
 * path (unchanged). There is no separate agent-tier "admin" role in this
 * bridge today — if one is wanted later, this is the seam to add it; until
 * then, a request that somehow reaches these three tools without having
 * cleared the MCP gate AND without a Netlify Identity admin session gets an
 * explicit, correctly-labeled 403 (error_code: admin_required), never the
 * misleading identity-verification failure.
 */
const requireArtifactBrowseAccess = async (event: LambdaEvent) => {
  if (event.mcpGateAuthenticated) return undefined;
  if (hasValidNetlifyPublishSecret(event)) return undefined;

  const adminState = await getAdminToolState(event);

  return 'isError' in adminState ? adminState : undefined;
};

const requireArtifactMigrationAccess = async (event: LambdaEvent) => {
  if (hasValidNetlifyPublishSecret(event)) return undefined;

  return requireAdminToolAccess(event);
};

export const normalizeArtifactKindInput = (value: unknown, required: boolean) => {
  const artifactKind = toNonEmptyString(value);
  if (!artifactKind)
    return required ? { ok: false as const, error: 'artifactKind is required.' } : { ok: true as const };
  if (!artifactKindValues.includes(artifactKind as (typeof artifactKindValues)[number])) {
    return { ok: false as const, error: `artifactKind must be one of: ${artifactKindValues.join(', ')}.` };
  }

  return { ok: true as const, artifactKind };
};

const normalizeArtifactSha256Input = (value: unknown) => {
  const sha256 = toNonEmptyString(value)?.toLowerCase();
  if (!sha256) return { ok: false as const, error: 'sha256 is required.' };
  if (!/^[a-f0-9]{64}$/.test(sha256)) return { ok: false as const, error: 'sha256 must be a 64-character hex digest.' };

  return { ok: true as const, sha256 };
};

const loadArtifactReferenceForAdminMutation = async (store: ArtifactIndexStore, requestId: string, sha256: string) => {
  const artifact = await parseJsonBlob(store, requestArtifactReferenceKey(requestId, sha256));

  if (!artifact) return { ok: false as const, error: 'Artifact reference was not found.' };
  if (!isArtifactReference(artifact)) return { ok: false as const, error: 'Artifact reference JSON is invalid.' };

  return { ok: true as const, artifact };
};

const writeArtifactReferenceForAdminMutation = async (
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

const normalizeDeletedByInput = (value: unknown, fallback: string) => {
  const deletedBy = toNonEmptyString(value) ?? fallback;

  if (!isSafeArtifactText(deletedBy, artifactReferenceLimits.label)) {
    return {
      ok: false as const,
      error: `deletedBy must be a safe string up to ${artifactReferenceLimits.label} characters.`,
    };
  }

  return { ok: true as const, deletedBy };
};

const getArtifactReferencesForRequest = async (event: LambdaEvent, requestId: string): Promise<ArtifactReference[]> => {
  const store = (await getArtifactIndexBlobStore(event)) as unknown as ArtifactIndexStore;
  return listArtifactReferencesForRequest(store, requestId);
};

export const listArtifactsForRequest = async (event: LambdaEvent, requestId: unknown) => {
  const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
  if (!normalizedRequestId) {
    return toolError('requestId is required.');
  }
  const requestIdValidation = validateRequestId(normalizedRequestId);
  if (!requestIdValidation.ok) return toolError(requestIdValidation.error);

  const artifacts = await getArtifactReferencesForRequest(event, requestIdValidation.value);

  return toolResult({
    artifacts,
  });
};

export const getArtifactMetadata = async (event: LambdaEvent, requestId: unknown, sha256: unknown) => {
  const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
  if (!normalizedRequestId) {
    return toolError('requestId is required.');
  }
  const requestIdValidation = validateRequestId(normalizedRequestId);
  if (!requestIdValidation.ok) return toolError(requestIdValidation.error);

  const normalizedSha256 = normalizeArtifactSha256Input(sha256);
  if (!normalizedSha256.ok) return toolError(normalizedSha256.error);

  const store = (await getArtifactIndexBlobStore(event)) as unknown as ArtifactIndexStore;
  const artifact = await readArtifactReference(store, requestIdValidation.value, normalizedSha256.sha256);

  if (!artifact) return toolError('Artifact reference was not found.');

  return toolResult(artifact);
};

export const listArtifactsByKind = async (event: LambdaEvent, input: Record<string, unknown>) => {
  const unauthorized = await requireArtifactBrowseAccess(event);
  if (unauthorized) return unauthorized;

  const artifactKind = normalizeArtifactKindInput(input.artifactKind, true);
  if (!artifactKind.ok) return toolError(artifactKind.error);

  const options = normalizeArtifactBrowseOptions(input);
  if (!isArtifactBrowseOptions(options)) return options;

  return listArtifactsFromPointerPrefixes(event, [`by-kind/${artifactKind.artifactKind}/`], options);
};

export const listArtifactsByRequest = async (event: LambdaEvent, input: Record<string, unknown>) => {
  const unauthorized = await requireArtifactBrowseAccess(event);
  if (unauthorized) return unauthorized;

  const requestId = toNonEmptyString(input.requestId);
  if (!requestId) return toolError('requestId is required.');

  const artifactKind = normalizeArtifactKindInput(input.artifactKind, false);
  if (!artifactKind.ok) return toolError(artifactKind.error);

  const options = normalizeArtifactBrowseOptions(input);
  if (!isArtifactBrowseOptions(options)) return options;

  const prefix = artifactKind.artifactKind
    ? `by-request/${encodeURIComponent(requestId)}/${artifactKind.artifactKind}/`
    : `by-request/${encodeURIComponent(requestId)}/`;

  return listArtifactsFromPointerPrefixes(event, [prefix], options);
};

export const searchArtifacts = async (event: LambdaEvent, input: Record<string, unknown>) => {
  const unauthorized = await requireArtifactBrowseAccess(event);
  if (unauthorized) return unauthorized;

  const options = normalizeArtifactBrowseOptions(input);
  if (!isArtifactBrowseOptions(options)) return options;

  const tag = toNonEmptyString(input.tag);
  const normalizedTag = tag ? safePathSegment(tag) : undefined;
  if (tag && !normalizedTag) return toolError('tag must contain at least one safe path character.');

  const prefixes = normalizedTag
    ? [`by-tag/${normalizedTag}/`]
    : artifactKindValues.map((artifactKind) => `by-kind/${artifactKind}/`);

  return listArtifactsFromPointerPrefixes(event, prefixes, options);
};

const requestArtifactKeyPattern = /^request-artifacts\/([^/]+)\/([a-f0-9]{64})\.json$/i;

const parseRequestArtifactIndexKey = (key: string) => {
  const match = key.match(requestArtifactKeyPattern);
  if (!match) return undefined;

  return { requestId: decodeURIComponent(match[1]), sha256: match[2].toLowerCase() };
};

const inferArtifactKindFromContentType = (contentType: unknown) => {
  const normalized = toNonEmptyString(contentType)?.toLowerCase().split(';', 1)[0] ?? '';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized === 'application/pdf') return 'pdf';
  if (
    normalized.startsWith('text/') ||
    normalized.includes('document') ||
    normalized === 'application/msword' ||
    normalized === 'application/rtf'
  ) {
    return 'doc';
  }
  if (normalized.includes('json') || normalized.includes('csv') || normalized.includes('xml')) return 'data';

  return 'other';
};

const getMigrationArtifactKind = (record: Record<string, unknown>, blobKey: string): string => {
  const explicitKind = toNonEmptyString(record.artifactKind);
  if (explicitKind && artifactKindValues.includes(explicitKind as (typeof artifactKindValues)[number]))
    return explicitKind;

  const [blobKeyKind] = normalizeArtifactBlobKey(blobKey).split('/');
  if (artifactKindValues.includes(blobKeyKind as (typeof artifactKindValues)[number])) return blobKeyKind;

  return inferArtifactKindFromContentType(record.contentType);
};

const migrationControlCharacters = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const unsafeMigrationFilenamePattern = new RegExp(`[${migrationControlCharacters}<>\\\\/]+`, 'gu');
const unsafeMigrationLabelPattern = new RegExp(`[${migrationControlCharacters}<>]+`, 'gu');

const normalizeMigrationFilename = (value: string) => {
  const filename = value.split(/[\\/]/).pop() || value;
  const normalized = filename
    .trim()
    .replace(/\s+/g, ' ')
    .replace(unsafeMigrationFilenamePattern, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, artifactReferenceLimits.originalFilename);

  return normalized || 'artifact';
};

const normalizeMigrationLabel = (value: string) => {
  const normalized = value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(unsafeMigrationLabelPattern, ' ')
    .slice(0, artifactReferenceLimits.label)
    .trim();

  return normalized || 'Artifact';
};

const getMigrationFilename = (record: Record<string, unknown>, blobKey: string, sha256: string) => {
  const metadata = getRecordValue(record.metadata);
  const metadataFilename = toNonEmptyString(metadata?.filename) ?? toNonEmptyString(metadata?.name);
  const existingFilename = toNonEmptyString(record.originalFilename);
  const blobFilename = normalizeArtifactBlobKey(blobKey).split('/').pop();

  return normalizeMigrationFilename(existingFilename ?? metadataFilename ?? blobFilename ?? sha256);
};

const getMigrationTags = (value: unknown) => {
  if (!Array.isArray(value)) return undefined;

  const tags = value.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()));

  return tags.length ? tags : undefined;
};

const migrateArtifactIndexRecord = async (store: ArtifactIndexStore, key: string, input: { dryRun: boolean }) => {
  const parsedKey = parseRequestArtifactIndexKey(key);
  if (!parsedKey) return { indexKey: key, status: 'skipped' as const, reason: 'unexpected request artifact key shape' };

  const raw = await parseJsonBlob(store, key);
  const record = getRecordValue(raw);
  const blobKey = toNonEmptyString(record?.blobKey);
  if (!record || !blobKey) return { indexKey: key, status: 'skipped' as const, reason: 'invalid artifact JSON' };

  const normalizedBlobKey = normalizeArtifactBlobKey(blobKey);
  const artifactKind = getMigrationArtifactKind(record, normalizedBlobKey);
  const originalFilename = getMigrationFilename(record, normalizedBlobKey, parsedKey.sha256);
  const label = normalizeMigrationLabel(toNonEmptyString(record.label) ?? originalFilename);
  const tags = getMigrationTags(record.tags);
  const migratedRecord = {
    ...record,
    blobKey: normalizedBlobKey,
    sha256: parsedKey.sha256,
    artifactKind,
    originalFilename,
    label,
    ...(tags ? { tags } : {}),
  };

  if (!isArtifactReference(migratedRecord)) {
    return { indexKey: key, status: 'skipped' as const, reason: 'artifact JSON is still invalid after migration' };
  }

  const referenceChanged = JSON.stringify(record) !== JSON.stringify(migratedRecord);
  if (!input.dryRun) {
    if (referenceChanged) {
      await writeArtifactReferenceForAdminMutation(store, parsedKey.requestId, migratedRecord);
    } else {
      await writeArtifactReferenceIndexes(store, parsedKey.requestId, migratedRecord);
    }
  }

  return {
    indexKey: key,
    requestId: parsedKey.requestId,
    sha256: parsedKey.sha256,
    artifactKind,
    status: input.dryRun ? ('dry_run' as const) : ('migrated' as const),
    referenceUpdated: referenceChanged,
    pointersWritten: input.dryRun ? 0 : 2,
  };
};

type WipeBlobStore = Awaited<ReturnType<typeof getArtifactBlobStore>>;

type WipeBlobTarget = {
  logicalPrefix: string;
  listPrefix: string;
  store: WipeBlobStore;
};

const WIPE_BLOB_ALLOWED_PREFIXES = [
  'workflows/',
  'artifact-index/',
  ...artifactKindValues.map((kind) => `${kind}/`),
] as const;
const WIPE_BLOB_ALLOWED_PREFIX_SET = new Set<string>(WIPE_BLOB_ALLOWED_PREFIXES);
const WIPE_BLOB_ARTIFACT_PREFIX_SET = new Set<string>(artifactKindValues.map((kind) => `${kind}/`));

const isArtifactWipeBlobPrefix = (prefix: string) => WIPE_BLOB_ARTIFACT_PREFIX_SET.has(prefix);

/**
 * No default-to-everything mode: `prefixes` was silently defaulting to EVERY
 * app-managed prefix (workflows/, artifact-index/, and every artifact kind),
 * so an operator meaning to wipe only legacy workflow records could delete
 * live object media with the same call shape. `prefixes` is now REQUIRED and
 * non-empty on every call, dry run included.
 */
const normalizeWipeBlobPrefixes = (value: unknown) => {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    return {
      prefixes: [] as string[],
      skipped: [] as string[],
      missing: true as const,
    };
  }

  if (!Array.isArray(value)) {
    return { prefixes: [] as string[], skipped: ['prefixes must be an array of strings.'], missing: false as const };
  }

  const prefixes: string[] = [];
  const skipped: string[] = [];
  for (const item of value) {
    const prefix = typeof item === 'string' ? item.trim() : '';
    if (!prefix || !WIPE_BLOB_ALLOWED_PREFIX_SET.has(prefix)) {
      skipped.push(String(item));
      continue;
    }

    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }

  return { prefixes, skipped, missing: false as const };
};

const getWipeBlobTargets = async (event: LambdaEvent, prefixes: string[]): Promise<WipeBlobTarget[]> => {
  const workflowsStorePromise = prefixes.includes('workflows/') ? getWorkflowBlobStore(event) : undefined;
  const artifactIndexStorePromise = prefixes.includes('artifact-index/') ? getArtifactIndexBlobStore(event) : undefined;
  const artifactStorePromise = prefixes.some(isArtifactWipeBlobPrefix) ? getArtifactBlobStore(event) : undefined;

  const workflowsStore = await workflowsStorePromise;
  const artifactIndexStore = await artifactIndexStorePromise;
  const artifactStore = await artifactStorePromise;

  return prefixes.flatMap((prefix) => {
    if (prefix === 'workflows/' && workflowsStore) {
      return [{ logicalPrefix: prefix, listPrefix: prefix, store: workflowsStore }];
    }

    if (prefix === 'artifact-index/' && artifactIndexStore) {
      return [{ logicalPrefix: prefix, listPrefix: '', store: artifactIndexStore }];
    }

    if (artifactStore && isArtifactWipeBlobPrefix(prefix)) {
      return [{ logicalPrefix: prefix, listPrefix: prefix, store: artifactStore }];
    }

    return [];
  });
};

const listWipeBlobTargetKeys = async (target: WipeBlobTarget) => {
  const blobs = await collectBlobListItems(await target.store.list({ prefix: target.listPrefix }));

  return [...new Set(blobs.map((blob) => blob.key))].sort();
};

const toLogicalWipeBlobKey = (target: WipeBlobTarget, key: string) => {
  if (target.logicalPrefix === 'artifact-index/') return `${target.logicalPrefix}${key}`;

  return key;
};

const isWipeBlobKeyAllowed = (target: WipeBlobTarget, key: string) => {
  if (!WIPE_BLOB_ALLOWED_PREFIX_SET.has(target.logicalPrefix)) return false;
  if (target.logicalPrefix === 'artifact-index/') return true;

  return key.startsWith(target.logicalPrefix);
};

export const wipeBlobStores = async (event: LambdaEvent, input: Record<string, unknown>) => {
  if (!hasValidNetlifyPublishSecret(event)) {
    return toolError('Unauthorized: a valid server publish key is required.');
  }

  const dryRun = input.dryRun !== false;
  if (!dryRun && input.confirm !== WIPE_BLOB_CONFIRMATION) {
    return toolError(`Live deletion requires confirm to equal ${WIPE_BLOB_CONFIRMATION}.`, {
      dryRun,
      deleted: 0,
      scanned: 0,
      skipped: 0,
      prefixes: [],
      sampleDeletedKeys: [],
    });
  }

  const normalizedPrefixes = normalizeWipeBlobPrefixes(input.prefixes);
  if (normalizedPrefixes.missing) {
    return toolError(
      'prefixes is required and must be a non-empty array — there is no default-to-everything mode. ' +
        'Pass exactly the prefixes you have verified are safe to wipe (dry run included).',
      {
        error_code: 'missing_prefixes',
        dryRun,
        deleted: 0,
        scanned: 0,
        skipped: 0,
        prefixes: [],
        sampleDeletedKeys: [],
      }
    );
  }

  const targets = await getWipeBlobTargets(event, normalizedPrefixes.prefixes);
  let scanned = 0;
  let deleted = 0;
  let skipped = normalizedPrefixes.skipped.length;
  const sampleKeys: string[] = [];
  const sampleDeletedKeys: string[] = [];

  for (const target of targets) {
    const keys = await listWipeBlobTargetKeys(target);

    for (const key of keys) {
      if (!isWipeBlobKeyAllowed(target, key)) {
        skipped += 1;
        continue;
      }

      scanned += 1;
      const logicalKey = toLogicalWipeBlobKey(target, key);
      if (sampleKeys.length < WIPE_BLOB_SAMPLE_LIMIT) sampleKeys.push(logicalKey);

      if (!dryRun) {
        await target.store.del(key);
        deleted += 1;
        if (sampleDeletedKeys.length < WIPE_BLOB_SAMPLE_LIMIT) sampleDeletedKeys.push(logicalKey);
      }
    }
  }

  return toolResult({
    dryRun,
    deleted,
    scanned,
    skipped,
    prefixes: normalizedPrefixes.prefixes,
    sampleKeys,
    sampleDeletedKeys,
    skippedPrefixes: normalizedPrefixes.skipped,
  });
};

export const migrateArtifactIndexes = async (event: LambdaEvent, input: Record<string, unknown>) => {
  const unauthorized = await requireArtifactMigrationAccess(event);
  if (unauthorized) return unauthorized;

  const limit = normalizeArtifactReconcileLimit(input.limit);
  if (!limit.ok) return toolError(limit.error);

  const cursor = normalizeArtifactBrowseCursor(input.cursor);
  if (!cursor.ok) return toolError(cursor.error);

  const dryRun = input.dryRun === true;
  const store = (await getArtifactIndexBlobStore(event)) as unknown as ArtifactIndexStore;
  const keys = await listArtifactIndexKeys(store, 'request-artifacts/');
  const pageKeys = keys.slice(cursor.value, cursor.value + limit.value);
  const results: Array<Awaited<ReturnType<typeof migrateArtifactIndexRecord>>> = [];

  for (const key of pageKeys) {
    results.push(await migrateArtifactIndexRecord(store, key, { dryRun }));
  }

  const nextOffset = cursor.value + pageKeys.length;
  const nextCursor = nextOffset < keys.length ? String(nextOffset) : null;
  const checkpoint = {
    cursor: String(cursor.value),
    nextCursor,
    lastKey: pageKeys.at(-1) ?? null,
    processed: results.length,
    totalKeys: keys.length,
  };
  const migrated = results.filter((result) => result.status === 'migrated' || result.status === 'dry_run').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const referenceUpdates = results.filter((result) => 'referenceUpdated' in result && result.referenceUpdated).length;
  const pointerWrites = results.reduce(
    (count, result) => count + ('pointersWritten' in result ? (result.pointersWritten ?? 0) : 0),
    0
  );

  console.info('Artifact index migration checkpoint.', { dryRun, migrated, skipped, referenceUpdates, ...checkpoint });

  return toolResult({
    dryRun,
    scanned: pageKeys.length,
    migrated,
    skipped,
    referenceUpdates,
    pointerWrites,
    checkpoint,
    results,
  });
};

export const softDeleteArtifact = async (event: LambdaEvent, input: Record<string, unknown>) => {
  const unauthorized = await requireAdminToolAccess(event);
  if (unauthorized) return unauthorized;

  const adminState = await getAdminToolState(event);

  const requestId = toNonEmptyString(input.requestId);
  if (!requestId) return toolError('requestId is required.');

  const sha256 = normalizeArtifactSha256Input(input.sha256);
  if (!sha256.ok) return toolError(sha256.error);

  const store = (await getArtifactIndexBlobStore(event)) as unknown as ArtifactIndexStore;
  const loaded = await loadArtifactReferenceForAdminMutation(store, requestId, sha256.sha256);
  if (!loaded.ok) return toolError(loaded.error);

  const adminEmail = !('isError' in adminState) ? adminState.email : undefined;
  const adminUserId = !('isError' in adminState) ? adminState.userId : undefined;
  const deletedBy = normalizeDeletedByInput(input.deletedBy, adminEmail ?? adminUserId ?? 'admin');
  if (!deletedBy.ok) return toolError(deletedBy.error);

  const deletedArtifact: ArtifactReference = {
    ...loaded.artifact,
    deletedAtISO: loaded.artifact.deletedAtISO ?? new Date().toISOString(),
    deletedBy: loaded.artifact.deletedBy ?? deletedBy.deletedBy,
  };

  await writeArtifactReferenceForAdminMutation(store, requestId, deletedArtifact);

  return toolResult({ artifact: deletedArtifact, deleted: true });
};

export const restoreArtifact = async (event: LambdaEvent, input: Record<string, unknown>) => {
  const unauthorized = await requireAdminToolAccess(event);
  if (unauthorized) return unauthorized;

  const requestId = toNonEmptyString(input.requestId);
  if (!requestId) return toolError('requestId is required.');

  const sha256 = normalizeArtifactSha256Input(input.sha256);
  if (!sha256.ok) return toolError(sha256.error);

  const store = (await getArtifactIndexBlobStore(event)) as unknown as ArtifactIndexStore;
  const loaded = await loadArtifactReferenceForAdminMutation(store, requestId, sha256.sha256);
  if (!loaded.ok) return toolError(loaded.error);

  const { deletedAtISO, deletedBy, ...restoredArtifact } = loaded.artifact;
  await writeArtifactReferenceForAdminMutation(store, requestId, restoredArtifact);

  return toolResult({ artifact: restoredArtifact, restored: Boolean(deletedAtISO || deletedBy) });
};

export const reconcileArtifactIndexes = async (event: LambdaEvent, input: Record<string, unknown>) => {
  const unauthorized = await requireAdminToolAccess(event);
  if (unauthorized) return unauthorized;

  const artifactKind = normalizeArtifactKindInput(input.artifactKind, false);
  if (!artifactKind.ok) return toolError(artifactKind.error);

  const limit = normalizeArtifactReconcileLimit(input.limit);
  if (!limit.ok) return toolError(limit.error);

  const requestId = toNonEmptyString(input.requestId);
  const prefix = requestId ? `request-artifacts/${encodeURIComponent(requestId)}/` : 'request-artifacts/';
  const indexStore = await getArtifactIndexBlobStore(event);
  const artifactStore = await getArtifactBlobStore(event);
  const keys = await loadArtifactIndexKeysFromPrefix(indexStore, prefix, limit.value);
  const { results, skipped } = await reconcileArtifactIndexKeys(
    artifactStore,
    indexStore,
    keys,
    artifactKind.artifactKind
  );
  const corrected = results.filter((result) => 'correctedBlobKey' in result).length;
  const found = results.filter((result) => result.status === 'found').length;
  const missing = results.filter((result) => result.status === 'missing').length;
  const ambiguous = results.filter((result) => result.status === 'ambiguous').length;

  return toolResult({
    scanned: keys.length,
    reconciled: results.length,
    corrected,
    found,
    missing,
    ambiguous,
    skipped,
    results,
  });
};
