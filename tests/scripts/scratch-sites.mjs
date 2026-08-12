/**
 * Shared definition of a SCRATCH tenant, and the fleet enumeration that ignores one.
 *
 * WHY THIS EXISTS — a cross-file test race.
 *
 * `admin-parity.test.mjs` proves parity checks by construction: it scaffolds a real
 * tenant under `sites/<slug>` with `writeFiles(buildPlan(...))`, degrades it, asserts
 * the check reports a GAP, then removes it in a `finally`. The directory is genuinely
 * present on disk for the duration of that test.
 *
 * Other suites enumerate `sites/*` to mean "every real tenant" — `genesis-manifest`
 * (does each tenant carry the whole genesis manifest?) and `client-scripts-site-bindings`
 * (does each tenant's app wire its bindings?). `npm test` runs the leg as
 * `node --test tests/scripts/*.test.mjs`, and node:test executes test FILES
 * CONCURRENTLY, in separate processes. So those enumerations can observe a scratch
 * tenant mid-flight.
 *
 * A freshly scaffolded tenant is genesis-stage by definition: it does not yet carry
 * onboarding-stage seeds or export subdirs. Enumerating one therefore fails the
 * manifest walk — nondeterministically, on whichever matrix entry happens to interleave:
 *
 *   ✖ every existing site carries every seed module the manifest lists
 *     sites/parity-scratch-bindcap/seeds/site-seed-data.mjs is missing …
 *
 * Observed on `main` (run 31578221279) and on PR #565, where re-running the SAME commit
 * moved the failure from `build (24)`/`parity-scratch-bindcap` to
 * `build (20)`/`parity-scratch-genesis` — the signature of interleaving, not of a defect.
 *
 * THE FIX is to make the predicate match the intent. Those suites mean "every real
 * tenant"; a transient scaffold owned by a concurrently-running test is not one. This
 * module is the single place that says so, so a future scratch tenant cannot be added
 * outside the protected namespace and silently reintroduce the race — `scratchSite()`
 * in admin-parity.test.mjs asserts its slug belongs to it.
 */
import fs from 'node:fs';

/**
 * Reserved namespace for tenants that a test creates and deletes within its own run.
 * Anything under `sites/` starting with this is transient by contract.
 */
export const SCRATCH_SITE_PREFIX = 'parity-scratch-';

export const isScratchSite = (name) => name.startsWith(SCRATCH_SITE_PREFIX);

/**
 * Every REAL tenant under `sites/`, sorted — discovered, never a hardcoded list, minus
 * any scratch tenant a concurrently-running test happens to have on disk right now.
 */
export const realTenantNames = (sitesDir) =>
  fs
    .readdirSync(sitesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !isScratchSite(name))
    .sort();
