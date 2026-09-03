/**
 * Repo-wide invariant: a core server function that reaches into `mcp.ts` must
 * inject that module's siblings first.
 *
 * `mcp.ts` holds three sibling handlers in MODULE state, injected once per site
 * by that site's `netlify/functions/mcp.ts` shim. Any OTHER lambda that imports
 * the module gets its own process with that state empty, and `requireSiblings()`
 * throws by design:
 *
 *     MCP server not configured — this site's shim must call configureMcp()
 *
 * Nothing catches it, so Netlify answers a bare 502. This has now happened
 * three times, in three different functions, and each one was found in
 * production rather than in a test:
 *
 *   - the admin chat lambdas   — first `create_agent_artifact_job` died
 *   - admin-plugin-manifest    — /admin/plugins showed "Request failed (502)"
 *   - plugin-actions           — /api/plugin/openapi.json 502'd, with a raw
 *                                stack on a PUBLIC endpoint, the moment a
 *                                manifest was promoted and the route stopped
 *                                short-circuiting at its 409
 *
 * Each was one line to fix and slow to find, and each hid behind a branch the
 * tests stopped at. The shape is a structural requirement, not a judgement
 * call, so it belongs in a scan rather than in reviewers' memory: import from
 * mcp.ts and call `ensureMcpSiblings(binding)`, or state why you do not need
 * to.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const FUNCTIONS_DIR = join(process.cwd(), 'packages', 'core', 'server', 'functions');

/**
 * Files that legitimately import mcp.ts without injecting.
 *
 * `mcp.ts` IS the module — its own shim injects. Everything else must justify
 * itself here, in one line, or call the helper.
 */
const EXEMPT = new Map([['mcp.ts', 'the module itself — the per-site /mcp shim calls configureMcp()']]);

/** Entry points that end up at `requireSiblings()`. */
const REACHES_INTO_MCP = [
  'visibleToolDefinitions',
  'objectStoreHandler',
  'verifyArticleImagesHandler',
  'saveArtifactHandler',
  'deployStatusHandler',
  // the /mcp handler itself, forwarded to by the actions façade
  'mcpHandler',
];

const sourceFiles = () =>
  readdirSync(FUNCTIONS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, source: readFileSync(join(FUNCTIONS_DIR, name), 'utf8') }));

test('every core function that reaches into mcp.ts injects its siblings first', () => {
  const offenders = [];

  for (const { name, source } of sourceFiles()) {
    if (EXEMPT.has(name)) continue;

    const importsMcp = /from '\.\/mcp\.js'/.test(source);
    if (!importsMcp) continue;

    const used = REACHES_INTO_MCP.filter((entry) => new RegExp(`\\b${entry}\\s*\\(`).test(source));
    if (used.length === 0) continue;

    if (!/\bensureMcpSiblings\s*\(/.test(source)) {
      offenders.push(`${name} calls ${used.join(', ')} but never calls ensureMcpSiblings(binding)`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These functions will throw "MCP server not configured" and 502 in production:\n  ${offenders.join('\n  ')}\n` +
      `Add ensureMcpSiblings(binding) (packages/core/server/lib/agent/mcp-siblings.ts) at the top of the handler.`
  );
});

test('the exemption list stays honest — an exempt file must still exist', () => {
  const names = new Set(sourceFiles().map((file) => file.name));
  for (const exempt of EXEMPT.keys()) {
    assert.ok(names.has(exempt), `${exempt} is exempted but no longer exists — drop it from the list`);
  }
});

test('the scan actually detects a function that forgot the call', () => {
  // Guards the guard: a regex that silently stopped matching would make this
  // suite pass forever. Both known-good and known-bad shapes are checked.
  const bad = "import { visibleToolDefinitions } from './mcp.js';\nconst h = () => visibleToolDefinitions();";
  const good = `${bad}\nensureMcpSiblings(binding);`;
  const detects = (source) =>
    /from '\.\/mcp\.js'/.test(source) &&
    REACHES_INTO_MCP.some((entry) => new RegExp(`\\b${entry}\\s*\\(`).test(source)) &&
    !/\bensureMcpSiblings\s*\(/.test(source);

  assert.equal(detects(bad), true, 'the scan must flag a function that reaches in without injecting');
  assert.equal(detects(good), false, 'and must not flag one that injects');
});
