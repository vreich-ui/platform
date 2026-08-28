/**
 * Canonical publish operation (T1.3) — the D§5.6 state machine:
 *
 *   validate (step 2) → materialize (step 3, T1.1) → commit (step 4, T1.2)
 *   → ONLY THEN stamp publication.published_time + publish_receipt in a
 *   single record write (step 5).
 *
 * Export-first-then-stamp is the entire point. The admin UI's article
 * Publish button (A§1.6 mechanism 1) stamps a timestamp and commits nothing
 * — the record claims "published" while no export exists. That anti-pattern
 * is structurally impossible here: no record write of any kind happens
 * before the export commit succeeds, so the forbidden state (stamped
 * record, no committed export) cannot occur.
 *
 * Failure semantics (D§5.6, publish direction):
 *   - Failure at or before the commit (validate / materialize / commit) →
 *     the record is byte-for-byte untouched and correctly unpublished; the
 *     error names the stage; the operation is safely retryable.
 *   - Commit succeeds, stamp write fails → the export is live in git while
 *     the record under-claims (still unpublished) — the reader-safe
 *     direction. This is surfaced as `stamp_failed_export_committed` with
 *     the receipt that could not be written and
 *     `reconciliation: 'retry_publish'`. The reconciliation path IS the
 *     mandatory idempotent retry: re-running publish with the same
 *     published_time re-materializes byte-identical output (T1.1
 *     determinism — the __generated marker embeds the published_time and
 *     the unchanged record version, never wall-clock), the committer
 *     detects the content already at head and no-ops (T1.2), and the stamp
 *     completes — converging on the same end state as a first-attempt
 *     success.
 *
 * The step-5 stamp bumps `version` (every write does) and NEVER
 * `content_revision` (D§3.1/§5.6 companion invariant: publishing consumes a
 * review approval pinned to content_revision and must not invalidate it).
 * As defense in depth, the stamp reloads the record and refuses to stamp if
 * `content_revision` moved while the export was being committed
 * (`content_changed_during_publish`): the committed export is stale against
 * the new body, and stamping would let the record claim a publish of
 * content that was never exported. That residual (export committed, record
 * unstamped, body newer) is again the under-claiming direction, repaired by
 * re-running publish for the current content.
 *
 * Scheduling (this phase): immediate-or-reject. Future published_time is
 * rejected outright — scheduling machinery is OQ-2, explicitly deferred.
 * `published_time: null` (unpublish, D§5.6) is likewise rejected: its
 * "remove/neutralize the export" step needs file-removal support the T1.2
 * committer does not have yet; a half-implemented unpublish that stamps
 * null while the export stays live would invert the reader-safe direction.
 *
 * Out of scope here, by design: tier/role/approval gating (T1.4) — this
 * operation assumes the caller is already authorized. Lock discipline is
 * NOT gating and is enforced (D§5.6 step 1, verbs parity): the caller must
 * hold the live lock, which is what makes concurrent body drift during a
 * publish the exception rather than the norm.
 */
import { materialize, type MaterializableObjectType, type MaterializedFile } from './materialize.js';
import {
  commitMaterializedFiles,
  ObjectGitCommitError,
  type CommitMaterializedFilesResult,
} from './object-git-committer.js';
import { isObjectLockActive, sanitizeObjectLock, type ObjectLockStore } from './object-lock.js';
import { objectRecordKey } from './object-store-keys.js';
import { summarizeValidation, validateObject, type ObjectValidationContext } from './object-validate.js';
import type {
  ObjectRecord,
  ObjectType,
  Principal,
  ProducerContext,
  PublishReceipt,
} from '../../schema/object-record-v1.js';

/** Tolerance for caller-computed "now" timestamps before a time counts as future. */
const SCHEDULING_SKEW_MS = 30_000;

/**
 * Object exports DEFER their production deploy. Every object-export commit
 * carries Netlify's skip marker, so pushing it to main does not build or
 * deploy — the exports accumulate on main and go live only on an explicit
 * release (the production build hook, fired once, produces a single deploy
 * that includes every skipped commit). Netlify: "[skip netlify]" in the
 * commit message prevents the branch/production deploy for a directly-pushed
 * commit, and the next un-skipped deploy includes the skipped changes. This is
 * appended here (T1.3, the object-export publish), NOT in the generic T1.2
 * committer, which stays message-agnostic and is reused by other callers.
 */
const NETLIFY_SKIP_MARKER = '[skip netlify]';
const withDeferredDeployMarker = (message: string): string =>
  message.includes(NETLIFY_SKIP_MARKER) ? message : `${message} ${NETLIFY_SKIP_MARKER}`;

export type ObjectPublishStore = ObjectLockStore;

export type PublishObjectInput = {
  object_type: ObjectType;
  object_id: string;
  /**
   * ISO instant. Omitted → now. Future → rejected (OQ-2). null → rejected
   * (unpublish lands with export-removal machinery, not in this phase).
   */
  published_time?: string | null;
  lock_token?: string;
  actor: Principal;
  /** Optional execution context recorded on this published revision. */
  producer?: ProducerContext;
  commit_message?: string;
};

export type PublishObjectDeps = {
  nowMs?: number;
  /** Cross-object resolvers for validation (T0.7); wired by callers as they exist. */
  validationContext?: ObjectValidationContext;
  /** Forwarded to the T1.2 committer (test injection / retry tuning). */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: (attempt: number) => number;
  maxAttempts?: number;
  /**
   * The site's committed-export root (SiteBinding.dataRoot, W11 T11.6), e.g.
   * 'sites/drlurie/data/site'. Required at call time — core has no default,
   * so a caller that forgets it fails loudly at materialize (below) rather
   * than silently writing to some hardcoded tree.
   */
  exportRoot?: string;
};

export type PublishFailureCode =
  | 'unsupported_object_type'
  | 'invalid_published_time'
  | 'scheduling_not_supported'
  | 'unpublish_not_supported'
  | 'not_found'
  | 'archived'
  | 'lock_required'
  | 'validation_failed'
  | 'materialize_failed'
  | 'export_commit_failed'
  | 'content_changed_during_publish'
  | 'stamp_failed_export_committed';

export type ObjectPublishResult = { status: number; body: Record<string, unknown> };

// The receipt shape is owned by publishReceiptSchema (object-record-v1.ts),
// which mirrors exactly what buildReceipt below writes — one source of truth
// since the schema tightening (2026-07-06).
export type ObjectPublishReceipt = PublishReceipt;

const ok = (body: Record<string, unknown>): ObjectPublishResult => ({ status: 200, body });
const err = (status: number, code: PublishFailureCode, body: Record<string, unknown>): ObjectPublishResult => ({
  status,
  body: { code, ...body },
});

const loadRecord = async (store: ObjectPublishStore, key: string): Promise<ObjectRecord | undefined> => {
  const raw = await store.get(key);
  return raw ? (JSON.parse(raw) as ObjectRecord) : undefined;
};

const buildReceipt = (
  commit: CommitMaterializedFilesResult,
  file: MaterializedFile,
  contentRevision: number,
  exportedAt: string
): ObjectPublishReceipt => ({
  kind: 'object_export_commit',
  branch: commit.branch,
  commit_sha: commit.commitSha,
  tree_sha: commit.treeSha,
  no_op: commit.noOp,
  attempts: commit.attempts,
  files: [file.path],
  content_revision: contentRevision,
  exported_at: exportedAt,
});

export const publishObject = async (
  store: ObjectPublishStore,
  input: PublishObjectInput,
  deps: PublishObjectDeps = {}
): Promise<ObjectPublishResult> => {
  const ts = deps.nowMs ?? Date.now();

  // content_item publishes through this generic path since W7.3 (OQ-8
  // resolved as migration): article objects materialize to JSON exports like
  // every other type. The legacy article pipeline continues to serve the
  // committed .md posts and is untouched by this operation.
  const objectType = input.object_type as MaterializableObjectType;

  // ── scheduling gate: immediate-or-reject (OQ-2 deferred) ──────────────────
  if (input.published_time === null) {
    return err(400, 'unpublish_not_supported', {
      error:
        'Unpublish (published_time: null) is not available in this phase: the committer has no export-removal support yet, and stamping null while the export stays live would be dishonest in the unsafe direction.',
    });
  }
  let effectivePublishedTime: string;
  if (input.published_time === undefined) {
    effectivePublishedTime = new Date(ts).toISOString();
  } else {
    const parsed = Date.parse(input.published_time);
    if (Number.isNaN(parsed)) {
      return err(400, 'invalid_published_time', { error: 'published_time must be an ISO 8601 instant.' });
    }
    if (parsed > ts + SCHEDULING_SKEW_MS) {
      return err(400, 'scheduling_not_supported', {
        error: 'Future-dated publishing is not available in this phase (OQ-2): publish immediately or not at all.',
        published_time: input.published_time,
      });
    }
    effectivePublishedTime = new Date(parsed).toISOString();
  }

  const key = objectRecordKey(input.object_type, input.object_id);
  const record = await loadRecord(store, key);
  if (!record) return err(404, 'not_found', { error: 'Object record not found', not_found: true });
  if (record.status === 'archived') {
    return err(409, 'archived', { error: 'Archived objects cannot be published.' });
  }

  // ── D§5.6 step 1: the caller must hold the live lock (verbs parity) ──────
  if (!record.lock || record.lock.token !== input.lock_token || !isObjectLockActive(record.lock, ts)) {
    return err(423, 'lock_required', {
      error: 'Lock required',
      locked: true,
      lock: sanitizeObjectLock(record.lock),
    });
  }

  // ── D§5.6 step 2: validate with publish intent (publish-gated invariants) ─
  const groups = validateObject(
    {
      objectType: input.object_type,
      objectId: input.object_id,
      body: record.body,
      published: record.publication.published_time != null,
    },
    { ...deps.validationContext, publishIntent: true }
  );
  const summary = summarizeValidation(groups);
  if (!summary.eligible) {
    return err(422, 'validation_failed', {
      error: 'Validation failed',
      validation: groups,
      blockers: summary.blockers,
    });
  }

  // ── D§5.6 step 3: materialize (pure; record untouched on failure) ─────────
  // Marker inputs are deliberately stable across retries: `at` is the
  // effective published_time (never wall-clock) and record_version is the
  // version we loaded — same inputs, same bytes (T1.1), which is what lets
  // a retried publish no-op in the committer instead of re-committing.
  const contentRevisionAtMaterialize = record.content_revision;
  let file: MaterializedFile;
  try {
    if (!deps.exportRoot) {
      throw new Error(
        'publishObject: deps.exportRoot is required (the site export root from its SiteBinding.dataRoot).'
      );
    }
    file = materialize(objectType, input.object_id, record.body, {
      at: effectivePublishedTime,
      record_version: record.version,
      exportRoot: deps.exportRoot,
      ...(input.producer ? { producer: input.producer } : {}),
    });
    if (!file.path || !file.content) throw new Error('Materializer returned an empty export.');
  } catch (error) {
    return err(500, 'materialize_failed', {
      error: 'Materialization failed; the record is unchanged and unpublished.',
      stage: 'materialize',
      detail: error instanceof Error ? error.message : String(error),
      retryable: false,
    });
  }

  // ── D§5.6 step 4: commit the export (record still untouched on failure) ───
  let commit: CommitMaterializedFilesResult;
  try {
    commit = await commitMaterializedFiles({
      files: [file],
      message: withDeferredDeployMarker(input.commit_message ?? `Publish ${input.object_type}: ${input.object_id}`),
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      backoffMs: deps.backoffMs,
      maxAttempts: deps.maxAttempts,
    });
  } catch (error) {
    if (error instanceof ObjectGitCommitError) {
      return err(error.statusCode, 'export_commit_failed', {
        error: 'Export commit failed; the record is unchanged and unpublished.',
        stage: 'export_commit',
        committer_code: error.code,
        detail: error.message,
        // A lost non-fast-forward race or transient API failure converges on
        // retry (T1.1 determinism + T1.2 no-op); a missing configuration or
        // bad input will not fix itself.
        retryable: error.code === 'non_fast_forward_exhausted' || error.code === 'github_api_error',
      });
    }
    throw error;
  }
  const receipt = buildReceipt(commit, file, contentRevisionAtMaterialize, effectivePublishedTime);

  // ── D§5.6 step 5: single stamp+receipt write, only after the commit ───────
  // Reload so the write is based on the freshest envelope (lock heartbeats
  // etc. may have bumped `version` while the commit ran) and so body drift
  // is detectable rather than silently stamped over.
  const fresh = await loadRecord(store, key);
  if (!fresh) {
    return err(500, 'stamp_failed_export_committed', {
      error: 'The export is committed but the record vanished before it could be stamped.',
      export_committed: true,
      receipt,
      reconciliation: 'retry_publish',
    });
  }
  if (fresh.content_revision !== contentRevisionAtMaterialize) {
    return err(409, 'content_changed_during_publish', {
      error:
        'The body changed while the export was being committed; the record was NOT stamped. The committed export reflects the older content — re-run publish to export and stamp the current content.',
      export_committed: true,
      receipt,
      materialized_content_revision: contentRevisionAtMaterialize,
      actual_content_revision: fresh.content_revision,
      reconciliation: 'retry_publish',
    });
  }

  const stampedAt = new Date(ts).toISOString();
  const stamped: ObjectRecord = {
    ...fresh,
    updated_at: stampedAt,
    publication: {
      ...fresh.publication,
      published_time: effectivePublishedTime,
      publish_receipt: receipt,
    },
    history: [
      ...fresh.history,
      {
        at: stampedAt,
        action: 'publish',
        actor: input.actor,
        details: {
          published_time: effectivePublishedTime,
          commit_sha: receipt.commit_sha,
          no_op: receipt.no_op,
          files: receipt.files,
          ...(input.producer ? { producer: input.producer } : {}),
        },
      },
    ],
    version: fresh.version + 1,
    // content_revision deliberately untouched: the stamp must never
    // invalidate the approval it consumes (D§3.1/D§5.6).
    content_revision: fresh.content_revision,
  };

  try {
    await store.setJSON(key, stamped);
  } catch (error) {
    return err(500, 'stamp_failed_export_committed', {
      error:
        'The export is committed and live, but the publish stamp could not be written; the record under-claims. Retry the publish with the same published_time — it will no-op the commit and complete the stamp.',
      export_committed: true,
      receipt,
      detail: error instanceof Error ? error.message : String(error),
      reconciliation: 'retry_publish',
    });
  }

  // The live permalink for a content_item (blog pattern /%slug%) — the publish
  // receipt tells the agent WHERE the article goes live instead of leaving the
  // route to be guessed (the post-publish-404 failure class).
  const articleSlug =
    input.object_type === 'content_item' &&
    fresh.body &&
    typeof fresh.body === 'object' &&
    !Array.isArray(fresh.body) &&
    typeof (fresh.body as { slug?: unknown }).slug === 'string'
      ? (fresh.body as { slug: string }).slug
      : undefined;

  return ok({
    published: true,
    object_type: input.object_type,
    object_id: input.object_id,
    published_time: effectivePublishedTime,
    receipt,
    version: stamped.version,
    content_revision: stamped.content_revision,
    ...(articleSlug ? { article_path: `/${articleSlug}` } : {}),
  });
};
