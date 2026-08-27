/**
 * Bulk object operations (T2.1) — orchestrates the existing per-object verbs
 * (`admin-object`, via `callObjectVerb`) over a SELECTED SET of rows, with a
 * bounded worker pool so a large selection doesn't fire N simultaneous
 * requests. `VerbCaller` is injected rather than importing
 * `edit-mode/verbs-client.ts` directly, so this module stays a pure function
 * of its inputs and is unit-testable with a fake verb caller — no network,
 * no DOM.
 *
 * Archive: checkout → retire → (checkin on failure, so a blocked archive
 * never leaves the object locked). This is the ONE real end-to-end bulk
 * verb T2.1 requires — `retire` (W14 F6) existed server-side with no admin
 * UI call site at all before this (T0.1 §7: "Reachable only via raw MCP").
 *
 * Validate: `object_validate` already has direct UI call sites elsewhere
 * (ObjectWorkspace.tsx) and needs no lock — this just fans it out.
 *
 * Tag: no generic "tag a governed object" verb exists on the MCP surface
 * (T0.1 §7's full verb table has none) — taxonomy assignment is a
 * per-type `patch` op, not a bulk-safe verb across all 13 object types. The
 * UI renders it disabled with a tooltip explaining why (never a button that
 * silently does nothing) rather than wiring something that isn't there.
 */

export interface BulkTargetRow {
  object_id: string;
  object_type: string;
}

export interface VerbResult {
  status: number;
  body: Record<string, unknown>;
}

export type VerbCaller = (body: Record<string, unknown>) => Promise<VerbResult>;

export interface BulkOpOutcome {
  object_id: string;
  ok: boolean;
  error?: string;
}

export interface BulkOpSummary {
  succeeded: string[];
  failed: BulkOpOutcome[];
}

const DEFAULT_CONCURRENCY = 3;

/** Runs `run` over `rows` with at most `concurrency` in flight at once. */
async function runPool<T>(rows: readonly T[], concurrency: number, run: (row: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      const row = rows[index];
      if (row !== undefined) await run(row);
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, rows.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
}

const errorMessage = (result: VerbResult, fallback: string): string => {
  const err = result.body.error;
  if (typeof err === 'string' && err.trim()) return err;
  if (result.status === 423) return 'Locked by someone else.';
  return fallback;
};

async function archiveOne(row: BulkTargetRow, callVerb: VerbCaller): Promise<BulkOpOutcome> {
  const checkout = await callVerb({ action: 'checkout', object_type: row.object_type, object_id: row.object_id });
  if (checkout.status !== 200) {
    return {
      object_id: row.object_id,
      ok: false,
      error: errorMessage(checkout, `Could not check out (${checkout.status}).`),
    };
  }
  const lockToken = checkout.body.lockToken;
  if (typeof lockToken !== 'string' || !lockToken) {
    return { object_id: row.object_id, ok: false, error: 'Checkout did not return a lock token.' };
  }

  const retire = await callVerb({
    action: 'retire',
    object_type: row.object_type,
    object_id: row.object_id,
    lock_token: lockToken,
  });
  if (retire.status === 200) return { object_id: row.object_id, ok: true };

  // Blocked (open review / still referenced) or another failure — release the
  // lock we just took rather than leaving the object checked out with
  // nothing to show for it. Best-effort: a failed checkin here doesn't
  // change the outcome already being reported.
  await callVerb({
    action: 'checkin',
    object_type: row.object_type,
    object_id: row.object_id,
    lock_token: lockToken,
  }).catch(() => undefined);

  return { object_id: row.object_id, ok: false, error: errorMessage(retire, `Archive failed (${retire.status}).`) };
}

/** Archives every row in the selection. Real end-to-end — the T2.1 acceptance criterion. */
export async function bulkArchiveObjects(
  rows: readonly BulkTargetRow[],
  callVerb: VerbCaller,
  opts: { concurrency?: number } = {}
): Promise<BulkOpSummary> {
  const succeeded: string[] = [];
  const failed: BulkOpOutcome[] = [];
  await runPool(rows, opts.concurrency ?? DEFAULT_CONCURRENCY, async (row) => {
    const outcome = await archiveOne(row, callVerb);
    if (outcome.ok) succeeded.push(outcome.object_id);
    else failed.push(outcome);
  });
  return { succeeded, failed };
}

export interface BulkValidateOutcome {
  object_id: string;
  ok: boolean;
  level?: 'ready' | 'warning' | 'missing';
  eligible?: boolean;
  blockerCount?: number;
  warningCount?: number;
  error?: string;
}

export interface BulkValidateSummary {
  results: BulkValidateOutcome[];
  readyCount: number;
  warningCount: number;
  blockedCount: number;
  requestFailedCount: number;
}

async function validateOne(row: BulkTargetRow, callVerb: VerbCaller): Promise<BulkValidateOutcome> {
  const result = await callVerb({ action: 'validate', object_type: row.object_type, object_id: row.object_id });
  if (result.status !== 200) {
    return {
      object_id: row.object_id,
      ok: false,
      error: errorMessage(result, `Validation failed (${result.status}).`),
    };
  }
  const summary = result.body.summary as
    | { level?: 'ready' | 'warning' | 'missing'; eligible?: boolean; blockers?: unknown[]; warnings?: unknown[] }
    | undefined;
  return {
    object_id: row.object_id,
    ok: true,
    level: summary?.level,
    eligible: summary?.eligible,
    blockerCount: summary?.blockers?.length ?? 0,
    warningCount: summary?.warnings?.length ?? 0,
  };
}

/** Validates every row in the selection (no lock needed — `object_validate` is a read). */
export async function bulkValidateObjects(
  rows: readonly BulkTargetRow[],
  callVerb: VerbCaller,
  opts: { concurrency?: number } = {}
): Promise<BulkValidateSummary> {
  const results: BulkValidateOutcome[] = [];
  await runPool(rows, opts.concurrency ?? DEFAULT_CONCURRENCY, async (row) => {
    results.push(await validateOne(row, callVerb));
  });
  return {
    results,
    readyCount: results.filter((r) => r.ok && r.level === 'ready').length,
    warningCount: results.filter((r) => r.ok && r.level === 'warning').length,
    blockedCount: results.filter((r) => r.ok && r.level === 'missing').length,
    requestFailedCount: results.filter((r) => !r.ok).length,
  };
}
