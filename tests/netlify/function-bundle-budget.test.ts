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
 *
 * ASV2 (`ui_capabilities` on the turn wire, chat-controls protocol §7) raised
 * admin-agent-chat 3420 -> 3440, measured at 3425 KB across 260 modules.
 *
 * The wave itself ratcheted this twice and landed at 3490 (measured 3471 /
 * 261): W4.3 added the edge `engine.ts -> lib/admin/ui-capabilities.ts ->
 * lib/admin/quick-actions.ts -> lib/admin/inventory-chat.ts` (+45 KB) and
 * W4.1 added `ui-capabilities.ts -> lib/admin/chat-controls.ts` (+24 KB).
 * Both sessions wrote down the same cut below and neither owned the files.
 *
 * ASV2-W5 (the review pass) TOOK BOTH CUTS, so most of that is reclaimed:
 * the registry DATA now lives in the leaf `lib/admin/quick-actions-registry.ts`
 * and the field KINDS in the leaf `lib/admin/controls-kinds.ts`;
 * `quick-actions.ts` and `chat-controls.ts` re-export every moved name, so no
 * call site changed, and `ui-capabilities.ts` imports the LEAF spelling. Three
 * modules left this bundle (`quick-actions.ts` 29 KB, `chat-controls.ts` 25 KB,
 * `inventory-chat.ts` 3.9 KB) and two joined it (7.9 KB + 1.8 KB). VERIFIED by
 * reproducing this file's own `firstPartyBundle()` before and after:
 * 3471.4 KB / 261 modules -> 3425.0 KB / 260 modules (the 0.8 KB
 * difference from the raw cut is ASV2-W5's own comments in `engine.ts`).
 *
 * What remains over the wave's 3402 KB / 257 base IS the feature: the manifest
 * builder, the registry data the server genuinely reads, and the kinds array.
 * There is no second copy of the verb list on the server — which is the drift
 * §6.4's offered-verb gate exists to prevent, and the reason the import edge
 * was right and only its SPELLING was wrong.
 *
 * MEASURED ON THE INTEGRATED TREE (ASV2 rebased onto A8, 2026-09-14):
 * 3494 KB across 262 modules — A8's 3467/259 plus this wave's net +27 KB /
 * +3 modules after both cuts above. Cap set to 3520 (26 KB headroom), a round
 * number rather than the tightest one that passes, per this file's own note.
 *
 * IF YOU TRIP THIS NEXT: check first that nothing has re-imported
 * `lib/admin/quick-actions.js` or `lib/admin/chat-controls.js` from server
 * code or from `ui-capabilities.ts`. Either spelling compiles and either
 * silently re-adds ~55 KB; only the leaf modules are on the server's diet.
 */
const BUDGETS_KB: Record<string, number> = {
  // The coalesced shell call — one navigation, one invocation. Capped first
  // because it is the one that now runs on every click.
  //
  // M2.1 (2026-09-16) added the `inventory` section and left the cap ALONE,
  // measured 431 KB / 48 modules (was 380 / 40). The section's own edge —
  // `lib/objects/index-store.ts`, M0's trusted read path — is +93 KB and
  // lands at 473 KB on its own; two cuts paid most of it back and both are
  // worth more than the section that forced them:
  //   · `lib/object-lock-view.ts` takes the two pure lock predicates out of
  //     `object-lock.ts`, a record-WRITE library, so `object-inventory.ts`
  //     stops dragging `objects/record-writer.ts` into every function that
  //     merely lists objects (-21 KB here, and `admin-users` pays 1 KB for
  //     the new file);
  //   · `lib/admin/request-list-order.ts` takes the request filter and sort
  //     out of `lib/admin/request-logic.ts`, whose other 50 KB is the
  //     request surface's UI vocabulary and `severity.ts` behind it (-51 KB
  //     here, and -53 KB on `admin-requests`, now 329 KB).
  //
  // The section M2.1 did NOT add is the reason that headroom mattered: wiring
  // `release` through `lib/release-overview.ts` measures 1605 KB, because that
  // module statically imports `handleObjectVerb`.
  //
  // M2.1b (2026-09-16) lit the section up and again left the cap ALONE,
  // measured 453 KB / 50 modules (was 431 / 48). The first spelling of the
  // edge — `lib/release/snapshot-store.ts`, which is what M1 exposes — measured
  // 489 KB / 52, because that module is the WRITER: `buildReleaseSnapshot`
  // reaches `lib/netlify-deploys.ts` (10 KB), `lib/production-release.ts`
  // (18 KB) and `lib/blob-list.ts`, none of which a boot can ever execute,
  // because the boot never rebuilds. So the read half moved to the leaf
  // `lib/release/snapshot-view.ts` (schema, the two pure derivations,
  // `readReleaseSnapshot`, the freshness predicate) and `snapshot-store.ts`
  // re-exports it whole, so no existing call site changed. 36 KB back, and
  // `admin-agent-chat` pays 2.6 KB for the new file.
  //
  // Exactly ONE module joins this bundle on top of the split
  // (`snapshot-view.ts` itself, 8.6 KB — `lib/admin/editorial-state.ts` came
  // with it and is 6 KB); `objects/index-store.ts` and `object-inventory.ts`
  // were already here for the `inventory` section, which is the whole reason
  // the release section costs one blob read rather than three.
  'admin-shell': 500,
  // Shell trio — still live (other callers, and the client's per-section
  // fallback when `admin-shell` is absent or a section errors).
  'admin-auth-state': 500,
  'admin-requests': 500,
  // M0.1 measured `admin-users` at 489 KB / 51 modules, up from 447 / 47. The
  // new edge is real and load-bearing: `membership/offboarding.ts` forces a
  // lock off an offboarded person, which is a RECORD write, and since M0.1
  // every record write goes through `objects/record-writer.ts` — which owes
  // the inventory a derived row. The first cut of that edge dragged the whole
  // inventory SWEEP in and measured 641 KB; two cuts brought it back under the
  // cap without raising it. `objects/index-doc.ts` split the two projection
  // DOCUMENTS away from the listing-driven sweep, so a writer imports the
  // documents and not the reader, and `lib/review-approval.ts` took the one
  // twenty-line function an inventory row needs out of `review-state.ts`,
  // whose discard path pulls ~100 KB of patch machinery an inventory row never
  // reads. 11 KB of headroom is thin — the next wave to touch this function
  // should expect to look for an edge, not a number.
  //
  // M2.1 measured it at 491 KB, +1 KB and +1 module: this function reaches
  // `object-lock.ts` through `membership/offboarding.ts` AND
  // `object-inventory.ts`, so splitting the read-only predicates into
  // `lib/object-lock-view.ts` adds that file here without removing the writer
  // it cut everywhere else. Paid deliberately — the same split is worth
  // 21 KB on `admin-shell` and on every future read-only caller. Headroom is
  // now 8 KB and the edge to look for remains the one named above.
  //
  // REVIEW (2026-09-16) 500 -> 520, measured 499 KB / 52 modules. No new
  // module and no new edge: `objects/index-doc.ts`, which this function
  // reaches through `membership/offboarding.ts` -> `record-writer.ts`, grew by
  // the drift alarm's compare-and-swapped arm, the sticky `armed` flag and the
  // note stating why `seq` alone could not carry the trusted index on a
  // runtime whose reads are silently eventual. The raise is for HEADROOM, not
  // for the measurement: the wave left 8 KB, the first correctness fix after
  // it left 0.8 KB, and a cap a hair under the number is a tripwire for the
  // next unrelated change rather than a budget. The real cut, when someone
  // needs it, is `projectIndexEntry`'s edge from `index-doc.ts` to
  // `object-inventory.ts` — a function that LISTS PEOPLE has no business
  // carrying the inventory row projection, and it is there only because the
  // record-write choke point owes the index a row.
  //
  // M3.2 (2026-09-16) added `snapshots/members.json` and did NOT raise this
  // cap, which is the whole story: the three new modules
  // (`snapshots/guarded-doc.ts`, `membership/snapshot-view.ts`,
  // `membership/snapshot-store.ts`) are +18 KB on a function that had 17 KB of
  // room, so the raise this would have forced was paid for with a cut instead.
  //
  // The cut is `lib/admin/display-name-core.ts`. `objectDisplayName` is reached
  // from `object-inventory.ts` through the record-write choke point and
  // `friendlyNameFromEmail` from three membership modules, so every admin
  // function that writes an object record or names a person was carrying the
  // whole SCREEN vocabulary with them — the status and navigation label tables,
  // `principalName`, `idTooltip` and the hundred-line `VERB_PHRASES` history
  // table, nine kilobytes of copy for views these functions never render.
  // `display-name.ts` re-exports every moved name, so no client call site
  // changed; the five server importers take the leaf spelling. Worth -9 KB here
  // and the same on `admin-shell` (476), `admin-requests` (353) and
  // `admin-auth-state` (229). Measured after both: 516 KB / 56 modules.
  //
  // IF YOU TRIP THIS NEXT: check first that no server module has gone back to
  // `lib/admin/display-name.js` for `objectDisplayName` or
  // `friendlyNameFromEmail`. Either spelling compiles and either silently
  // re-adds 9 KB; only the `-core` leaf is on the diet. The cut this file has
  // named since M0.1 — `projectIndexEntry`'s edge to `object-inventory.ts` — was
  // examined again here and is NOT available: `inventoryRowFromRecord` needs
  // essentially the whole of that module (the recipe and content summaries, the
  // score digest, the lock state), so extracting it moves ~13 KB of source into
  // a new file rather than out of this bundle.
  //
  // M3.3 (2026-09-16) STAYS UNDER the cap — no raise — at 517.9 KB / 54 modules,
  // up from 502.6 / 53. The new module is `visual-identity/snapshot-doc.ts`,
  // the second alarm-guarded projection the record-write choke point maintains,
  // and this function reaches it exactly as it reaches the first: through
  // `membership/offboarding.ts` -> `record-writer.ts`, which can force a lock
  // off a `template` as easily as off a page. Three things kept it under:
  // `object-inventory-row.ts` (the cut the note above has been naming — the
  // filter/sort/detail half of `object-inventory.ts` is no longer in this
  // graph), reusing `index-doc.ts`'s `readDocBlob`/`usableEtag`/store type
  // instead of copying the alarm plumbing, and keeping the long-form rationale
  // in `visual-identity/snapshot-store.ts`, which this function never imports.
  // 2 KB of headroom is thin: the next change here should expect to pay the
  // edge this function's own entry point carries, `artifact-soft-delete.ts` +
  // `artifact-trust.ts` — 78 KB of artifact machinery on a function that lists
  // people — before it pays another number.
  //
  // INTEGRATE (wave 2, 2026-09-16). The two numbers above were measured on two
  // branches that did not yet know about each other. On the INTEGRATED tree
  // they add up and the cap busts at 531.2 KB / 57 modules, which is the whole
  // point of measuring here rather than on a branch. No raise; two cuts, both
  // the leaf-spelling kind this note keeps describing:
  //
  //  1. `MAJOR_KEY_ARTIFACT_REF_RE`. The entry point took it from
  //     `lib/artifact-trust.ts`, which only RE-EXPORTS it — it has lived in the
  //     leaf `packages/core/lib/artifact-paths.ts` since 2026-09-16, because
  //     `Logo.astro` needs it at Astro build time and cannot load Netlify
  //     Blobs. Taking the re-export dragged `artifact-index.ts` for one regex.
  //     -5.7 KB. (This is HALF of the named 78 KB cut: the other half,
  //     `artifact-soft-delete.ts` -> `artifact-index.ts`/`artifacts.ts`, is NOT
  //     available — that module genuinely reads and rewrites the reference and
  //     its pointers, and it is already the leaf mutation T2.1 extracted.)
  //  2. `lib/oauth-subject-index.ts`, a new leaf. `membership/offboarding.ts`
  //     needs `subjectIndexPrefix`, `subjectIndexEntrySchema` and the store
  //     type to revoke a removed person's grants, and took them from
  //     `oauth-store.ts` — 27 KB of token minting, hashing, rotation and
  //     family revocation that this function can never execute, loaded before
  //     a handler that LISTS PEOPLE runs its first line. -24 KB.
  //
  // Measured on the integrated tree: 499.2 KB / 56 modules. 20 KB of headroom,
  // which is the first real room this function has had since M0.1.
  //
  // IF YOU TRIP THIS NEXT: the same trap as `display-name.js` above, twice
  // over. `from './artifact-trust.js'` for `MAJOR_KEY_ARTIFACT_REF_RE` and
  // `from './oauth-store.js'` for anything by-subject both compile and both
  // silently re-add their subtree; only `lib/artifact-paths.ts` and
  // `lib/oauth-subject-index.ts` are on the diet.
  'admin-users': 520,
  // Ratchet only; see the header note.
  //
  // 3520 -> 3536 (W4 first-run fix, 2026-09-15). NOT a new import edge and not
  // new server code on the diet: the tree had already crept from the measured
  // 3494 KB to 3519 KB, and W4's fix to `artifact-dedupe-sweep.ts` — a module
  // already in this graph — pushed it 3 KB over on COMMENTS explaining why the
  // reference walk must skip the `history` ledger. Cutting that explanation to
  // buy 3 KB would trade the reason a sweep silently retired nothing for a
  // number. Re-measured: 3522 KB / 262 modules, so this is 14 KB of headroom,
  // and the next wave that eats it should look for a real edge first.
  //
  // 3536 -> 3552 (CHAT-ORIGIN, 2026-09-16). Looked for the edge first, as the
  // note above asks, and there is none: the module SET is byte-for-byte the
  // same 263 modules before and after that change. What grew is
  // `context.origin` plumbing and its comments inside five modules already in
  // the graph. Most of those bytes explain why a field sent one agent rev too
  // early burns the turn_id permanently.
  // 3552 -> 3568 (PCL-P1, C-20, 2026-09-16). ONE new first-party module,
  // `agent/pending-approval-lock.ts` (263 -> 264): the approval-card lock
  // heartbeat the `get_chat` poll drives. Its transitive deps (`object-lock`,
  // `object-store-keys`, the record schema) were already in this graph, so
  // this is not a new import EDGE into a heavy subtree — it is the module's
  // own ~5 KB, most of it the comment explaining why the heartbeat is driven
  // by the browser poll and never by a server timer.
  //
  // PCL-P4 (starter chips, 2026-09-16, rebased onto CHAT-ORIGIN): stays UNDER
  // the existing cap — no raise from PCL-P1's. ONE new first-party module,
  // `lib/admin/starter-chips.ts`: the chip-deriving pure function
  // `chatSummary` calls on an object-kind chat, plus one more optional field
  // (`origin_starter`) threaded through the already-present CHAT-ORIGIN
  // plumbing in `agent/chat-store.ts` / `agent/loop.ts` / `agent/engine.ts` /
  // `functions/admin-agent-chat.ts`. `buildObjectContract` was already in
  // this graph (via `agent/context.ts`), so this is the module's own weight,
  // not a new edge into the registry's zod trees. Measured after this
  // rebase: 3563.9 KB / 265 modules, so 4.1 KB of headroom — cap held at
  // PCL-P1's 3568, not raised.
  // 3536 -> 3580 (M0.1, 2026-09-16), and that IS the "look for a real edge
  // first" pass, done. There is no new edge: this graph already reached
  // `objects/index-store.ts` through `object-verbs.ts`, so what grew is
  // first-party SOURCE inside a subtree it was already paying for — the
  // record-write choke point (`objects/record-writer.ts`), the document layer
  // split out beneath it (`objects/index-doc.ts`), the leaf
  // `review-approval.ts`, and the header in `index-store.ts` that states why a
  // read may now trust an index it did not verify. Measured 3565 KB / 267
  // modules. The two cuts that saved `admin-users` (the doc/sweep split and
  // the review-state extraction) were applied first and are worth ~25 KB here
  // too; without them this would be asking for 3605.
  //
  // 3580 -> 3610 (M1, 2026-09-16), and the "look for a real edge first" pass
  // again finds none. Module count went 267 -> 268: exactly ONE new first-party
  // file, `lib/release/snapshot-store.ts`, and the three modules it reaches
  // (`objects/index-store.ts`, `netlify-deploys.ts`, `production-release.ts`)
  // were all already in this graph through `object-verbs.ts` and
  // `mcp-tool-handlers.ts`. The edge is load-bearing and is the milestone
  // itself: `object-publish.ts` refreshes `snapshots/release.json` as part of
  // the publish stamp, so the surface that shows an editor their own publish
  // does not have to compute it. Measured 3598 KB / 268 modules.
  //
  // What was NOT done, deliberately: the 24 KB file is mostly the comment that
  // states which facts are stored and which are re-derived per read, which is
  // the one decision the rest of M1 follows from. The W4 note above already
  // refused that trade once — cutting an explanation to buy a few KB trades the
  // reason a mechanism exists for a number.
  //
  // MEASURED ON THE INTEGRATED TREE (REVIEW pass, 2026-09-16): 3606 KB across
  // 271 modules, not the 3598 / 268 the M1 note above recorded — that number
  // was taken before M2.1/M2.1b/M2.2 met it on one branch, and this file's own
  // law is that the integrated tree is what counts. The wave's module delta was
  // VERIFIED against `main` (2e89567) by reproducing `firstPartyBundle()` on
  // both sides and diffing the metafile's module SET: 263 -> 271, eight files
  // ADDED and none removed, and every one of the eight is first-party source
  // this wave wrote or newly reached —
  //   objects/record-writer.ts · objects/index-doc.ts · review-approval.ts ·
  //   object-lock-view.ts (M0.1's choke point and the three leaf cuts it
  //   forced), release/snapshot-store.ts · release/snapshot-view.ts ·
  //   lib/admin/editorial-state.ts (M1, reached through the snapshot's
  //   derivations), lib/admin/request-list-order.ts (M2.1's request cut).
  // The two raises' central claim holds: `netlify-deploys.ts` and
  // `production-release.ts` are NOT in the added set — they were already in
  // this graph through `mcp-tool-handlers.ts` — so no third-party edge and no
  // new subtree was waved through.
  //
  // 3610 -> 3640 (REVIEW, 2026-09-16), measured 3614 KB / 271 modules. Module
  // count UNCHANGED at 271, so there is no edge here either: the +9 KB is the
  // drift-alarm fix inside `objects/index-doc.ts`, a file this graph already
  // carried. Headroom was 4 KB after M1's raise, which is why a bug fix tripped
  // it; 26 KB restores the margin this file's own note asks for after four
  // consecutive raises on <=3 KB. The next wave here should still pay for the
  // `agent/tools.ts` definitions-vs-executors cut this file has been naming
  // since A4, not for another number.
  //
  // 3640 -> 3680 (REBASE onto live main @ #771, 2026-09-16). Measured 3650 KB
  // across 274 modules. The +10 KB and +3 modules came from MAIN, not from this
  // wave: 271 was measured against 2e89567, and PCL-P1/PCL-P4 landed
  // `agent/pending-approval-lock.ts` and `lib/admin/starter-chips.ts` in the
  // meantime, each with its own "no new edge" note above. This wave's own delta
  // is unchanged and still verified module-set-for-module-set. The raise keeps
  // the 26 KB of headroom the REVIEW note above asked for after four
  // consecutive raises on <=3 KB, so the next change here is not forced into
  // another number; the `agent/tools.ts` definitions-vs-executors cut this file
  // has been naming since A4 is still the debt to pay.
  //
  // M3.1 (2026-09-16) added `snapshots/chats.json` and did NOT raise this cap
  // either. Five modules join this graph — the two chat snapshot halves, the two
  // membership ones (reached through `users-store.ts`) and the shared
  // `snapshots/guarded-doc.ts` — for +28 KB against 30 KB of room, after the
  // `display-name-core.ts` cut described above paid back 8 KB of it. Measured
  // 3676 KB / 279 modules. The `agent/tools.ts` definitions-vs-executors cut
  // this file has been naming since A4 is still the debt to pay, and the next
  // change here should expect to pay it rather than ask for a number.
  //
  // M3.3 (2026-09-16) stays under it too: 3668 KB / 276 modules, up from
  // 3649.8 / 274. Two new first-party files, `visual-identity/snapshot-doc.ts`
  // and `object-inventory-row.ts`, both reached through `object-verbs.ts` ->
  // `objects/record-writer.ts`, which this graph already carried. No new edge
  // and no new subtree; the rebuild half (`visual-identity/snapshot-store.ts`)
  // is NOT here, because only the read path imports it.
  //
  // INTEGRATE (wave 2, 2026-09-16). Same story as `admin-users`: +28 and +18
  // measured separately are +65 together (M3.4's governance snapshot halves
  // join through `genesis-policy-verbs.ts`), and the integrated tree busts at
  // 3714.7 KB / 284 modules. No raise. The cut is `lib/admin/request-logic.ts`
  // — 51 KB, 63 with its exclusive subtree — which three SERVER modules were
  // pulling in for two small things that already had leaves, or should have:
  //
  //  - `agent/context.ts` took `filterRequestRows`/`sortRequestRows` from it,
  //    when M2.1 had already split them into `lib/admin/request-list-order.ts`
  //    for exactly this reason and `request-logic.ts` merely re-exports them.
  //  - `agent/tools.ts` and `requests/activity.ts` took `nodeLabel`, a
  //    thirty-line id->phrase table, now in the leaf
  //    `lib/admin/request-node-labels.ts` and re-exported from `request-logic.ts`.
  //
  // What those three edges were dragging is the admin SCREEN vocabulary — row
  // actions and their rights, quick filters, publish-policy refusal sentences,
  // empty states, notification scanning — into functions that render no screen.
  // Measured on the integrated tree: 3657.7 KB / 283 modules, 22 KB of room.
  // The `agent/tools.ts` definitions-vs-executors cut is STILL the debt.
  'admin-agent-chat': 3680,
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
