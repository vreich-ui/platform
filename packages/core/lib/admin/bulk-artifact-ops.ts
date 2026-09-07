/**
 * Bulk artifact operations (T3) — fans `deleteArtifact` / `retagArtifact`
 * (`inventory-client.ts`, backed by the `admin-inventory` server function)
 * out over a selected set of artifact ids, with the same bounded worker
 * pool as `bulk-object-ops.ts`. A client function is injected rather than
 * imported directly so this module stays a pure function of its inputs and
 * is unit-testable with a fake client — no network, no DOM.
 *
 * One failing artifact (e.g. refused because it's still referenced by an
 * active object, per BRIEF.md's verb matrix) never aborts the run — every
 * id gets its own outcome, aggregated into `{ok, failed}` for the bulk
 * toolbar's per-item result report.
 */

export interface BulkArtifactOutcome {
  id: string;
  reason?: string;
}

export interface BulkArtifactSummary {
  ok: string[];
  failed: BulkArtifactOutcome[];
}

/** Matches `inventory-client.ts`'s `deleteArtifact`/`retagArtifact` signatures, minus the injected `getToken`. */
export type DeleteArtifactFn = (id: string) => Promise<unknown>;
export type RetagArtifactFn = (id: string, add: string[], remove: string[]) => Promise<unknown>;

const DEFAULT_CONCURRENCY = 3;

/** Runs `run` over `ids` with at most `concurrency` in flight at once. */
async function runPool<T>(ids: readonly T[], concurrency: number, run: (id: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      if (id !== undefined) await run(id);
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, ids.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
}

const reasonFrom = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
};

/**
 * Deletes every artifact in `ids`. Never aborts the whole run on one
 * failure — a refusal (still referenced, not found, network error) is
 * recorded per-id in `failed` with its reason.
 */
export async function bulkDeleteArtifacts(
  ids: readonly string[],
  deleteFn: DeleteArtifactFn,
  opts: { concurrency?: number } = {}
): Promise<BulkArtifactSummary> {
  const ok: string[] = [];
  const failed: BulkArtifactOutcome[] = [];
  await runPool(ids, opts.concurrency ?? DEFAULT_CONCURRENCY, async (id) => {
    try {
      await deleteFn(id);
      ok.push(id);
    } catch (error) {
      failed.push({ id, reason: reasonFrom(error, 'Delete failed.') });
    }
  });
  return { ok, failed };
}

/**
 * Adds/removes tags on every artifact in `ids`, same tag delta applied to
 * each. Never aborts the whole run on one failure.
 */
export async function bulkRetagArtifacts(
  ids: readonly string[],
  add: readonly string[],
  remove: readonly string[],
  retagFn: RetagArtifactFn,
  opts: { concurrency?: number } = {}
): Promise<BulkArtifactSummary> {
  const ok: string[] = [];
  const failed: BulkArtifactOutcome[] = [];
  const addTags = [...add];
  const removeTags = [...remove];
  await runPool(ids, opts.concurrency ?? DEFAULT_CONCURRENCY, async (id) => {
    try {
      await retagFn(id, addTags, removeTags);
      ok.push(id);
    } catch (error) {
      failed.push({ id, reason: reasonFrom(error, 'Retag failed.') });
    }
  });
  return { ok, failed };
}
