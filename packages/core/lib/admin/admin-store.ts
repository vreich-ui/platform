/**
 * admin-store.ts (M2.2) — the shared ledger behind "ask this navigation's
 * `admin-shell` boot before asking a dedicated endpoint," for the two
 * `/admin/*` sections that had no consumer as of M2.1: `inventory` and
 * `release`.
 *
 * ## Why this exists, and why it is not a sixth cache
 *
 * `access`, `me` and `requests` already have exactly the shape M2.2 asks
 * for — a module-scope store, hydrated from the boot payload, that is THE
 * place its surfaces read from — each in its own file:
 * `admin-access-client.ts` (+ `admin-shell-client.ts`'s
 * `fetchAdminAccessStateViaShell`), `use-current-user.ts`, and
 * `requests-store.ts`. All three already survive an Astro `ClientRouter`
 * navigation, because module scope does — `use-current-user.ts`'s own header
 * says so ("the in-memory module snapshot ... survives an Astro ClientRouter
 * swap ... it did before this change") — with no `transition:persist`
 * involved anywhere. Building a SEVENTH, unified store that those three
 * would have to be rewritten onto, for zero behaviour change, would be the
 * opposite of "additive, minimal diffs" (AGENTS.md §3.2), and the rewrite
 * itself is exactly the kind of change that can leave two surfaces reading
 * two different snapshots of "the same" section mid-migration.
 *
 * So this module is the missing HALF of that same pattern: the pure ledger —
 * is this entry stale, who wrote it (this navigation's coalesced boot call,
 * or a surface's own dedicated-endpoint fetch), how old is its own
 * `as_of`/`generated_at`. `library-client.ts` (`inventory`) and
 * `release-client.ts` (`release`) record into it and invalidate it, and the
 * decision itself is one decision, tested once here with `node:test` per
 * AGENTS.md §4's "no DOM test stack, extract the decision to a pure module"
 * rule, rather than copy-pasted into two client files that could drift.
 *
 * ## REVIEW (2026-09-16) — what it does NOT do yet, said plainly
 *
 * Nothing READS this ledger in production. `recordAdminStoreEntry` and
 * `invalidateAdminStoreEntry` have live call sites; `getAdminStoreEntry` and
 * `isAdminStoreEntryStale` are called only by this module's tests. The
 * freshness decision the two surfaces actually make is still their own
 * module-scope cache's (`library-client.ts`'s `INVENTORY_TTL_MS` +
 * `sessionStorage`, `release-client.ts`'s 15 s `memoryCache`), and M2.2 did
 * not move it here — deliberately, because moving a cache mid-wave is how two
 * surfaces end up reading two different snapshots of one section.
 *
 * So today this records PROVENANCE (which of the two sources answered, and
 * when) and keeps the invalidation of a boot-sourced entry in step with a
 * network-sourced one. That is worth having and is not the same as being the
 * store the header above describes; whoever consumes the predicate should
 * make it the surfaces' only freshness decision rather than a third one.
 *
 * `access`/`me`/`requests` deliberately do NOT route through this ledger:
 * their own stores already are it, in the shape their many existing
 * consumers already depend on, and moving them here would be a rename with
 * no functional change and a real regression risk.
 */
import type { AdminShellSectionName } from './admin-shell-client.js';

/** The two sections this ledger tracks. `access`/`me`/`requests` keep their own established stores — see the header. */
export type AdminStoreSectionName = Extract<AdminShellSectionName, 'inventory' | 'release'>;

/** Who last wrote a ledger entry: this navigation's coalesced boot call, or the section's own dedicated-endpoint fetch. */
export type AdminStoreSource = 'boot' | 'network';

export interface AdminStoreEntry<T> {
  data: T;
  /**
   * The section's own `generated_at`/`as_of`, when the payload carries one.
   * `undefined` for an older server, or a network answer this module never
   * threaded one through for — never faked, because a surface may render it
   * as "as of <time>" and a guessed value there is worse than none.
   */
  asOf: string | undefined;
  source: AdminStoreSource;
  /** When THIS entry was recorded, by the client clock — the staleness bound below is measured against this, not `asOf`, so a section whose payload carries no `as_of` still expires. */
  fetchedAtMs: number;
}

const entries = new Map<AdminStoreSectionName, AdminStoreEntry<unknown>>();

/** The section's current ledger entry, or `undefined` if nothing has been recorded yet this session, or it was invalidated. */
export function getAdminStoreEntry<T>(name: AdminStoreSectionName): AdminStoreEntry<T> | undefined {
  return entries.get(name) as AdminStoreEntry<T> | undefined;
}

/** Records a fresh answer — from the shell or from the section's own endpoint. Both are genuine writes; neither is preferred over the other once recorded. */
export function recordAdminStoreEntry<T>(
  name: AdminStoreSectionName,
  data: T,
  asOf: string | undefined,
  source: AdminStoreSource,
  nowMs: number = Date.now()
): AdminStoreEntry<T> {
  const entry: AdminStoreEntry<T> = { data, asOf, source, fetchedAtMs: nowMs };
  entries.set(name, entry as AdminStoreEntry<unknown>);
  return entry;
}

/**
 * A mutation (publish, approve, archive, a request transition) changed what
 * this section would answer. The next read must go to the network however
 * young the current entry is — this is the escape hatch the staleness bound
 * below cannot express on its own, and it is what keeps
 * `invalidateInventoryCache` / `invalidateReleaseOverview`'s existing call
 * sites correct: both now call this too, so a surface that read its data
 * from the shell boot is invalidated exactly as one that read it from the
 * dedicated endpoint always was.
 */
export function invalidateAdminStoreEntry(name: AdminStoreSectionName): void {
  entries.delete(name);
}

/**
 * Pure staleness predicate — the decision this module exists to make
 * testable without a DOM. `undefined` (nothing recorded yet, or invalidated)
 * is always stale. A boot answer and a network answer expire the same way:
 * arriving via the coalesced call is not a promise to stay current longer
 * than a live fetch would have.
 */
export function isAdminStoreEntryStale(
  entry: AdminStoreEntry<unknown> | undefined,
  maxAgeMs: number,
  nowMs: number = Date.now()
): boolean {
  if (!entry) return true;
  return nowMs - entry.fetchedAtMs > maxAgeMs;
}

/** Test-only: back to an empty ledger, so one test file's entries never leak into the next `it()`. */
export function resetAdminStoreForTests(): void {
  entries.clear();
}
