/**
 * T2.1 — cold-start bundle caps for the admin functions.
 *
 * Netlify cold-starts a function by loading its ENTIRE bundle before the
 * handler's first line runs, so a function's module graph is a COLD-START
 * latency number, not a tidiness one.
 *
 * WHAT THIS FILE IS AND IS NOT, corrected 2026-09-13. T2.1 opened with the
 * 445 ms → 5164 ms call-to-call spread measured on the shell trio and read it
 * as a bundle-size result. T0.1's `Server-Timing` wave then measured the same
 * endpoints directly and disproved that reading: every sampled invocation
 * reported `cold=0`, and `admin-auth-state` did 0.02 ms of server work for
 * 242-683 ms on the wire. The spread is dominated by ~250-400 ms of fixed
 * per-INVOCATION platform overhead, which no bundle cap can touch — that is
 * why the fix for the admin's per-click floor was `admin-shell` (fewer calls),
 * not a smaller bundle.
 *
 * These caps still earn their place, for the narrower thing they actually
 * govern: the first invocation on a new container, where the whole graph IS
 * loaded before the handler runs, and where `admin-users` at 2.58 MB was a
 * real multi-second stall. Read them as a cold-start ratchet, and never as an
 * explanation for warm call-to-call variance.
 *
 * What is measured: bundle each site shim in `netlify/functions/` with
 * esbuild, `packages: 'external'` (so node_modules are excluded and the
 * number is stable against dependency churn), and sum the metafile's INPUT
 * bytes — i.e. every byte of FIRST-PARTY TypeScript source statically
 * reachable from the entry point. That is the quantity a bad import edge
 * moves: `admin-users` sat at 2.58 MB / 208 modules purely because one
 * ~15-line avatar soft-delete reached `lib/mcp-artifact-admin.ts`, which
 * imports `functions/mcp.ts` — the whole MCP tool surface — back for its
 * `toolError`/`toolResult` helpers. Cutting that ONE edge (the mutation now
 * lives in the leaf `lib/artifact-soft-delete.ts`) took it to 392 KB / 43
 * modules with no behavior change.
 *
 * The SHELL TRIO — `admin-auth-state`, `admin-requests`, `admin-users` — is
 * capped together because all three fire on EVERY `/admin/*` navigation (see
 * lib/admin/use-current-user.ts). `admin-auth-state` at 192 KB is the shape
 * the other two are held to.
 *
 * `admin-shell` joins them under the same cap and the same bans, and is the
 * one that matters most: it is the COALESCED call the shell now makes instead
 * of the three (T-shell — `Server-Timing` showed the per-click floor is ~250-400
 * ms of fixed per-invocation overhead, not server work), so it runs on every
 * navigation whether or not the other three do. It comes in UNDER the two it
 * supersedes on the read path precisely because it imports the two read paths
 * from leaf modules — `lib/requests/list-snapshot.ts` and
 * `lib/membership/session.ts` — instead of importing `admin-requests.ts` and
 * `admin-users.ts`, which would have pulled the workflow-cancel bridge and the
 * whole membership-management surface (~200 KB) into a function that only
 * reads. If this cap ever fails, suspect exactly that: a new import edge from
 * `admin-shell.ts` to one of the action handlers.
 *
 * `admin-agent-chat` is a RATCHET, not a target: ~81% of its weight IS the
 * mcp.ts subtree, and unlike admin-users that coupling is real — the chat
 * executes MCP tool bodies on its send path (lib/agent/context.ts) and
 * injects mcp.ts's siblings on every invocation (lib/agent/mcp-siblings.ts).
 * Cutting it means making `configureMcp` bootstrap lazy across every site
 * shim plus the scaffold generator; that is a separate, larger change. The
 * cap exists so it cannot grow quietly in the meantime.
 *
 * If a cap fails: find the offending edge rather than raising the number —
 *   node -e "…" with esbuild's metafile, or reproduce this test's own
 *   `firstPartyBundle()` and walk `metafile.inputs`' import lists back to the
 *   entry. Raising a cap is a deliberate, commented act.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildSync } from 'esbuild';

const KB = 1024;

/**
 * Under the ci-test harness this file runs COMPILED from .tmp/ci-test, so
 * resolve the REAL repo root (the nearest ancestor carrying both a
 * package.json and the function shims) exactly as tracking-loader.test.ts does.
 */
const repoRoot = (() => {
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (root !== path.dirname(root)) {
    if (
      existsSync(path.join(root, 'package.json')) &&
      existsSync(path.join(root, 'netlify/functions/admin-users.ts'))
    ) {
      return root;
    }
    root = path.dirname(root);
  }
  throw new Error('repo root not found from ' + fileURLToPath(import.meta.url));
})();

const bundleInputs = (fn: string, options: { externalPackages: boolean }) => {
  const entry = path.join(repoRoot, 'netlify/functions', `${fn}.ts`);
  assert.ok(existsSync(entry), `function shim not found: ${entry}`);

  const built = buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    metafile: true,
    write: false,
    logLevel: 'silent',
    absWorkingDir: repoRoot,
    outfile: path.join(repoRoot, '.tmp/bundle-budget', `${fn}.mjs`),
    ...(options.externalPackages ? { packages: 'external' as const } : {}),
    // Several server modules are CJS-interop shaped; give the ESM output a
    // `require` so bundling never fails for a reason unrelated to size.
    banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  });

  return built.metafile!.inputs;
};

/** First-party TypeScript source statically reachable from a function's entry point. */
const firstPartyBundle = (fn: string) => {
  const inputs = bundleInputs(fn, { externalPackages: true });
  const modules = Object.keys(inputs);

  return {
    modules,
    bytes: Object.values(inputs).reduce((total, input) => total + input.bytes, 0),
  };
};

/**
 * Caps in KB of first-party source. Measured 2026-09-10 at:
 *   admin-auth-state 192 · admin-requests 340 · admin-users 392 · admin-agent-chat 3140
 *
 * A3 (2026-09-13) raised admin-agent-chat 3328 → 3340: three new read-only
 * chat tools (list_operations/get_operation/preflight_operation) plus the
 * pure operation-catalog.ts module they and run_workspace_workflow's new
 * operation_id routing share, measured at 3330 KB. No new import edge — the
 * module imports only zod and the already-reachable requests/store.js type;
 * this is real first-party feature code, not a coupling regression.
 *
 * Legacy-owner self-heal (2026-09-13) raised it 3340 → 3352, measured at
 * 3341 KB. Wiring adoption into resolveArtifactBridgeScope's MISS path makes
 * lib/artifact-legacy-adopt.ts (7.2 KB, dead since #733) reachable; the rest
 * is the resolver's own wiring. Exactly ONE module joins the graph — the
 * heaviest thing adoption reaches, lib/artifact-dedupe-sweep.ts at 19.7 KB
 * for its collectReferencedArtifactKeys, was already in the bundle via the
 * artifact_orphan_sweep/artifact_dedupe_by_sha tools, so it costs nothing
 * here. Nothing to cut: the new module IS the feature, and it drags no new
 * subtree behind it.
 *
 * Media compaction (W4, 2026-09-13) raised it 3352 -> 3356, measured at
 * 3353 KB. NO new module and NO new import edge: the grace window
 * (`minAgeMs`/`skippedRecent`) and its rationale comment land inside
 * lib/artifact-dedupe-sweep.ts, which the artifact_orphan_sweep /
 * artifact_dedupe_by_sha tools already drag into this bundle, plus the
 * verb's `skipped_recent` passthrough in mcp-artifact-admin.ts. The
 * scheduled function that uses them (server/functions/media-compaction-sweep.ts)
 * is NOT reachable from here and costs this bundle nothing. Nothing to cut:
 * the delta is the safeguard that keeps an unattended sweep from retiring a
 * capture's artifacts before capture has written the pages citing them.
 *
 * W2.0 write-time artifact-ownership claim (2026-09-13) raised it 3356 → 3364,
 * measured at 3359 KB on top of the media-compaction tree. NO new module and NO
 * new import edge: the claim lives in mcp-tool-handlers.ts's own
 * `callObjectAction` and uses `readRequestOwner` / `writeRequestOwner` /
 * `PUBLIC_ARTIFACT_PATH_RE`, all three already imported there. The 6 KB is this
 * function plus the comment that says why it exists — first-party feature code
 * in a module the bundle already carries whole, so there is no import edge to
 * cut.
 *
 * Admin-truthfulness wave (2026-09-13) raised it 3364 -> 3372, measured at
 * 3367 KB on top of the W2.0 tree. NO new import edge: every byte is new logic inside modules the
 * bundle already reached — `requests/derive-status.ts` (stall reasoning
 * extended to a queued run), `requests/store.ts` + the new
 * `requests/request-kind.ts` (id-evidence kind reconciliation, ~2 KB, imported
 * only by store.ts and importing only a type), and
 * `lib/admin/request-logic.ts` / `lib/admin/visual-identity-imagery.ts` (the
 * empty-state, detail-facts and applied-drift derivations, which live in
 * lib/admin precisely so they can be tested). Nothing to cut: no module joins
 * the graph and no subtree comes with it.
 *
 * Re-measured 2026-09-13, after the shell coalescing (T-shell):
 *   admin-auth-state 216 · admin-requests 367 · admin-users 438 · admin-shell 369
 *
 * Pointer sort key (W3 T1, 2026-09-13) raised admin-agent-chat 3352 -> 3360,
 * measured at 3357 KB. There is NO import edge to cut here: the module count
 * is unchanged at 256 before and after, because both files that grew
 * (lib/artifact-index.ts, lib/artifact-soft-delete.ts) were already in the
 * graph. The growth is `ArtifactPointer` gaining createdAtISO/deletedAtISO,
 * `parseArtifactPointer`/`repairArtifactPointer`, and the reasoning for why a
 * read path is allowed to write a pointer at all. Headroom was 1 KB before
 * this, which is why a documentation-and-two-helpers change tripped it.
 *
 * Variants projection (W4.1, 2026-09-13) raised admin-agent-chat 3360 -> 3368,
 * measured at 3363 KB. Again NO import edge to cut: the module count is 256
 * before and after, because both files that grew — server/lib/object-inventory
 * .ts and server/lib/objects/index-store.ts — were already in the graph via
 * object-verbs. The growth is the `content` summary a content_item inventory
 * row now carries (slug, lineage.parent_content_id, the judged-score digest)
 * plus the index schema bump and its rebuild-on-read reporting, which is what
 * turns /admin/variants from 40 admin-object invocations into 1. Trimmed from
 * an initial 3364 KB by cutting prose, not code; what is left IS the feature.
 * Headroom was 3 KB before this — a second consecutive raise on a 3 KB margin
 * means the next change here should expect to pay for a real cut, not prose.
 *
 * Rebase onto the admin-truthfulness wave (2026-09-13) raised it 3372 -> 3392,
 * measured at 3384 KB across 257 modules. This is the SUM of two independently
 * measured raises meeting on one branch, not a new edge: the pointer sort key
 * and the variants projection each grew files already in the graph, and the
 * truthfulness wave had separately taken the cap to 3372 on main. The module
 * count moved 256 -> 257 from that wave's own work, not from W3. The margin is
 * deliberately widened to 8 KB: four consecutive raises on a <=3 KB headroom
 * is a ratchet that spends a whole task's review on prose trimming. The next
 * change that trips this should cut the agent/tools.ts definitions-vs-executors
 * split (~127 KB of executors that never run on the governance read path),
 * which is the one real cut left in this bundle.
 *
 * A4 executor-operation dispatch (2026-09-13) raised admin-agent-chat
 * 3392 -> 3420, measured at 3399 KB. VERIFIED, not assumed: reproduced this
 * file's own firstPartyBundle() against origin/main (c6f4b523) for
 * admin-agent-chat and diffed the metafile's module SET — 257 modules on
 * both sides, zero added, zero removed. There is no import edge to cut; the
 * +14.2 KB is two files already in the graph growing in place — agent/
 * tools.ts (+10.5 KB: resolveCatalogOperation's `dispatch` discriminated
 * union for the executor-vs-workflow kind, the new runExecutorOperation
 * entrypoint that calls operation_execute instead of
 * workflow_start_dry_run, and its refusal relay including the
 * not-yet-granted diagnosis) and agent/operation-catalog.ts (+3.7 KB: the
 * executorBinding wire shape and operation.execute's own result schema).
 * Cap rounded up to 3420 (21 KB headroom) rather than measured+8 — the
 * pattern above has round-tripped through <=3 KB margins four times because
 * each raise picked the tightest number that passed; a rounder number here
 * is deliberately not that number.
 *
 * A8 gap-1 close (2026-09-14) raised admin-agent-chat 3420 -> 3500, measured
 * at 3467 KB across 259 modules (was 257). This IS a new edge, and it is the
 * whole point of the change: `packages/core/lib/pdf/template-preview.ts`
 * (524 lines) and `packages/core/lib/pdf/document-render.ts` (244 lines)
 * existed before this as orphan pure modules — reachable from nothing but
 * their own test files, hence invisible to this bundle — and are now wired
 * into `mcp-tool-handlers.ts` (two new handlers, `callPreviewPdfTemplateFixture`
 * / `callDocumentRender`) so the admin chat can actually call them. A module
 * that cannot be reached cannot cost a KB; making it reachable is gap 1
 * closing, not drift. No other file in the graph grew. Headroom rounded to
 * 33 KB (3500 vs the 3467 measured) rather than the tightest number that
 * passed, matching this file's own stated preference above.
 */
const BUDGETS_KB: Record<string, number> = {
  // The coalesced shell call — one navigation, one invocation. Capped first
  // because it is the one that now runs on every click.
  'admin-shell': 500,
  // Shell trio — still live (other callers, and the client's per-section
  // fallback when `admin-shell` is absent or a section errors).
  'admin-auth-state': 500,
  'admin-requests': 500,
  'admin-users': 500,
  // Ratchet only; see the header note.
  'admin-agent-chat': 3500,
};

/** Every function the admin shell can reach on a navigation — the trio plus the call that coalesces them. */
const SHELL_FUNCTIONS = ['admin-shell', 'admin-auth-state', 'admin-requests', 'admin-users'];

for (const [fn, capKb] of Object.entries(BUDGETS_KB)) {
  test(`BUNDLE BUDGET: ${fn} stays under ${capKb} KB of first-party source`, () => {
    const { bytes, modules } = firstPartyBundle(fn);
    assert.ok(
      bytes <= capKb * KB,
      `${fn} is ${(bytes / KB).toFixed(0)} KB across ${modules.length} first-party modules (cap ${capKb} KB). ` +
        'Find and cut the import edge that grew it — do not raise the cap without a comment saying why.'
    );
  });
}

/**
 * The specific edge T2.1 cut, asserted by shape so a future refactor cannot
 * reintroduce it under a different name: NOTHING a shell-trio function loads
 * may reach the MCP tool surface. `functions/mcp.ts` alone drags
 * mcp-tool-handlers, object-validate, object-verbs, the two tool-definition
 * tables, the PDF render-data mapper, and brand-imagery-proxy's `sharp` seam.
 */
const MCP_SURFACE = [
  'packages/core/server/functions/mcp.ts',
  'packages/core/server/lib/mcp-tool-handlers.ts',
  'packages/core/server/lib/mcp-artifact-admin.ts',
  'packages/core/server/lib/brand-imagery-proxy.ts',
];

for (const fn of SHELL_FUNCTIONS) {
  test(`SHELL TRIO: ${fn} does not statically import the MCP tool surface`, () => {
    const { modules } = firstPartyBundle(fn);
    const found = MCP_SURFACE.filter((mod) => modules.includes(mod));
    assert.deepEqual(
      found,
      [],
      `${fn} reaches ${found.join(', ')}. Soft-delete and friends live in the leaf ` +
        'packages/core/server/lib/artifact-soft-delete.ts precisely so this stays empty.'
    );
  });
}

/**
 * `sharp` (a native image codec) and `stripe` are the two heaviest packages a
 * server module can pull in. Both are already behind `await import(...)` at
 * their entry points (lib/brand-imagery-proxy.ts, lib/image-validation.ts,
 * lib/artifact-image-bound.ts, functions/admin-get-blob-image.ts, and
 * lib/stripe-env.ts), with type-only `import type` for their types — but
 * esbuild still follows a dynamic import into the bundle, so the only way a
 * shell-trio function stays free of them is to not reach those modules at
 * all. This asserts the real bundle, node_modules included.
 */
for (const fn of SHELL_FUNCTIONS) {
  test(`SHELL TRIO: ${fn} bundles neither sharp nor stripe`, () => {
    const modules = Object.keys(bundleInputs(fn, { externalPackages: false }));
    for (const pkg of ['sharp', 'stripe']) {
      const hit = modules.find((mod) => mod.startsWith(`node_modules/${pkg}/`));
      assert.equal(
        hit,
        undefined,
        `${fn} bundles ${pkg} (via ${hit}) — that is a cold start the admin shell pays for.`
      );
    }
  });
}
