/**
 * QA-W16-1 (HIGHEST PRIORITY finding, 2026-08-06 live QA session): write
 * calls to `object_create`, `create_pdf_template`, `create_agent_artifact_job`,
 * `object_publish`, and `release_to_production` returned a client-facing
 * timeout or a Cloudflare 502 at least 14 times across one session — and
 * every single time, the underlying write had ALREADY LANDED server-side by
 * the time it was re-checked with a read. A caller that treats "the call
 * errored" as "nothing happened" and retries naively creates a silent
 * duplicate for any of these (a second content_item, a second rendered
 * artifact, a second production build/release).
 *
 * This module is the fix: an idempotency-key bridge shared by every write
 * tool, not reimplemented per tool or per site connector. Usage at a call
 * site (see mcp.ts's callTool switch):
 *
 *   return withIdempotentToolCall(event, 'object_create', input.idempotency_key, () =>
 *     callObjectAction(event, { action: 'create', ... }));
 *
 * Semantics:
 *   - No idempotency_key supplied → behaves exactly as before (runs the write
 *     every time). Callers that don't opt in see no behavior change.
 *   - First call with a given (tool, key) → runs the write, and if it
 *     succeeds, stores the result keyed on `idem:{tool}:{key}` with
 *     onlyIfNew:true (so a genuine race between two concurrent requests
 *     carrying the same key can't both "win" the store).
 *   - A repeat call with the same (tool, key) → the write is NOT re-run; the
 *     original stored result is replayed verbatim (with
 *     `replayed_from_idempotency_key: true` added so the caller can tell).
 *   - A FAILED attempt (toolError — validation_failed, lock_required, etc.)
 *     is deliberately NOT stored: nothing landed server-side for those, so a
 *     retry with the same key should genuinely re-attempt the write rather
 *     than replay a stale failure forever.
 *
 * This closes the gap even when the client-visible failure is a transport
 * timeout/502 that never reached this code at all: because the store write
 * happens inside the SAME function invocation that performed the write,
 * before the (possibly already-abandoned) HTTP response is returned, a
 * function that keeps running past the caller's timeout budget still
 * persists its own result — so the next attempt with the same key finds it.
 * It does not help the rarer case where the platform kills the invocation
 * before the write itself completes; that case is a genuine no-op and a
 * fresh retry is correct and safe.
 */
import { getIdempotencyBlobStore } from './blob-store.js';
import type { SiteBinding } from './site-binding.js';

/** The minimal blob-store surface this module needs — real store or a test double. */
export type IdempotencyBlobStore = {
  get(key: string): Promise<string | null>;
  setJSON(
    key: string,
    value: unknown,
    options?: { onlyIfNew?: boolean }
  ): Promise<void | { modified: boolean; etag?: string }>;
};

/** The shape every tool handler in this bridge returns (toolResult/toolError from mcp.ts). */
export type ToolCallResponse = {
  isError?: boolean;
  content?: unknown;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
};

type StoredIdempotentResult = {
  storedAtISO: string;
  response: ToolCallResponse;
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Bound the key so a caller can't use this as an unbounded-size blob store. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

const idempotencyBlobKey = (toolName: string, idempotencyKey: string) => `idem:${toolName}:${idempotencyKey}`;

/**
 * Testable core: run `run()` under an idempotency key scoped to `toolName`,
 * against an already-resolved store (real Netlify Blobs store or a test
 * double). See module comment for full semantics.
 */
export const withIdempotencyStore = async (
  store: IdempotencyBlobStore,
  toolName: string,
  idempotencyKeyInput: unknown,
  run: () => Promise<ToolCallResponse>
): Promise<ToolCallResponse> => {
  if (!isNonEmptyString(idempotencyKeyInput)) return run();

  const idempotencyKey = idempotencyKeyInput.trim().slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  const blobKey = idempotencyBlobKey(toolName, idempotencyKey);

  const existingRaw = await store.get(blobKey);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as StoredIdempotentResult;
      return {
        ...existing.response,
        structuredContent: {
          ...(existing.response.structuredContent ?? {}),
          replayed_from_idempotency_key: true,
          idempotency_key: idempotencyKey,
          original_result_at: existing.storedAtISO,
        },
      };
    } catch {
      // A corrupt stored record must never block the caller — fall through
      // and re-run the write as if no record existed.
    }
  }

  const result = await run();

  // Only a SUCCESSFUL write is idempotency-safe to replay: nothing landed
  // server-side for a toolError, so the correct behavior on retry is to try
  // again, not to keep replaying the same failure.
  if (!result.isError) {
    const record: StoredIdempotentResult = { storedAtISO: new Date().toISOString(), response: result };
    try {
      // onlyIfNew: if a concurrent request with the identical key already
      // won this write, keep ITS stored result rather than overwrite it —
      // both callers should converge on the exact same body.
      const setResult = await store.setJSON(blobKey, record, { onlyIfNew: true });
      if (setResult && setResult.modified === false) {
        const winnerRaw = await store.get(blobKey);
        if (winnerRaw) {
          const winner = JSON.parse(winnerRaw) as StoredIdempotentResult;
          return {
            ...winner.response,
            structuredContent: {
              ...(winner.response.structuredContent ?? {}),
              replayed_from_idempotency_key: true,
              idempotency_key: idempotencyKey,
              original_result_at: winner.storedAtISO,
            },
          };
        }
      }
    } catch {
      // Best-effort: if the idempotency store write itself fails, still
      // return the (successful) result to the caller rather than erroring
      // out a write that actually succeeded.
    }
  }

  return result;
};

/**
 * Production entry point: resolves the real per-site idempotency store from
 * `event` (exactly like every other per-site store getter in this codebase —
 * getSiteObjectsBlobStore, getArtifactBlobStore, ...) and delegates to
 * `withIdempotencyStore`. Call sites (mcp.ts's callTool) use this one; tests
 * use `withIdempotencyStore` directly with an injected store.
 */
export const withIdempotentToolCall = async (
  event: unknown,
  toolName: string,
  idempotencyKeyInput: unknown,
  run: () => Promise<ToolCallResponse>,
  binding?: SiteBinding
): Promise<ToolCallResponse> => {
  if (!isNonEmptyString(idempotencyKeyInput)) return run();

  const store = await getIdempotencyBlobStore(event, binding);
  return withIdempotencyStore(store, toolName, idempotencyKeyInput, run);
};

/**
 * A second, smaller job this same strongly-consistent store is well-suited
 * for: a plain TTL'd value cache, namespaced so it can never collide with the
 * `idem:{tool}:{key}` records above. First consumer: mcp-tool-handlers.ts
 * caches a per-jobId artifact-bridge scope resolution here (perf/drop-verify-
 * hop-cache-scope) so a poll loop stops re-running the whole object-store
 * ownership check on every single request. Unlike the idempotency records
 * above, entries here are safe to overwrite unconditionally — this is a
 * cache, not a once-only write ledger — and a corrupt/expired/missing entry
 * is always just a miss, never an error the caller has to handle.
 */
type CachedValueEnvelope<T> = { value: T; expiresAtMs: number };

const cachedValueBlobKey = (namespace: string, key: string) => `cache:${namespace}:${key}`;

export const getCachedValue = async <T>(
  store: IdempotencyBlobStore,
  namespace: string,
  key: string,
  nowMs: number = Date.now()
): Promise<T | undefined> => {
  let raw: string | null;
  try {
    raw = await store.get(cachedValueBlobKey(namespace, key));
  } catch {
    return undefined; // a store read failure is always a cache MISS, never a hard failure
  }
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as CachedValueEnvelope<T>;
    if (typeof parsed.expiresAtMs !== 'number' || parsed.expiresAtMs <= nowMs) return undefined;
    return parsed.value;
  } catch {
    return undefined;
  }
};

export const setCachedValue = async <T>(
  store: IdempotencyBlobStore,
  namespace: string,
  key: string,
  value: T,
  ttlMs: number,
  nowMs: number = Date.now()
): Promise<void> => {
  const envelope: CachedValueEnvelope<T> = { value, expiresAtMs: nowMs + ttlMs };
  try {
    await store.setJSON(cachedValueBlobKey(namespace, key), envelope);
  } catch {
    // Best-effort: a cache WRITE failure must never fail the caller's request —
    // the next call simply falls through to a live resolve again.
  }
};
