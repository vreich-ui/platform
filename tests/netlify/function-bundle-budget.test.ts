/**
 * T2.1 — cold-start bundle caps for the admin functions.
 *
 * Netlify cold-starts a function by loading its ENTIRE bundle before the
 * handler's first line runs, so a function's module graph is a latency
 * number, not a tidiness one. The measured spread on the shell trio was
 * 445 ms → 5164 ms for the same function, call to call.
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
 */
const BUDGETS_KB: Record<string, number> = {
  // Shell trio — every /admin/* navigation pays these three.
  'admin-auth-state': 500,
  'admin-requests': 500,
  'admin-users': 500,
  // Ratchet only; see the header note.
  'admin-agent-chat': 3328,
};

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

for (const fn of ['admin-auth-state', 'admin-requests', 'admin-users']) {
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
for (const fn of ['admin-auth-state', 'admin-requests', 'admin-users']) {
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
