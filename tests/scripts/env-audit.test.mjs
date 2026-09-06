/**
 * R8.2 — `packages/core/cli/env-audit.mjs` (`npm run env:audit [--fix]`).
 *
 * Plain, uncompiled node:test run directly against the real repo, picked up
 * by `npm test`'s `node --test tests/scripts/*.test.mjs` leg (the
 * create-site-json.test.mjs precedent for testing a packages/core/cli/*.mjs
 * script without the tsc pass create-site.test.ts needs for zod schemas).
 *
 * Covers: inherited (team-level and site-level present cases), missing, and
 * `--fix` (mints TRACKING_SALT, sets TRACKING_PROJECT_ID, idempotent on a
 * second run), plus the hard safety invariant for this whole task: no env
 * VALUE — for a fleet-shared row or any other — ever reaches stdout or gets
 * written into a site's own env.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AUDIT_ROWS, auditSiteEnv, fixSiteEnv, listClientSlugs, main, renderSiteAuditReport } from '../../packages/core/cli/env-audit.mjs';

const SECRET_MARKER = 'must-never-surface-anywhere';

const captureConsole = async (run) => {
  const outLines = [];
  const errLines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => outLines.push(String(line));
  console.error = (line) => errLines.push(String(line));
  let returned;
  try {
    returned = await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { outLines, errLines, returned };
};

test('AUDIT_ROWS is exactly the four tracking tenancy-axis rows, sourced from create-site.mjs (single source of truth)', () => {
  assert.deepEqual(
    AUDIT_ROWS.map((row) => row.name),
    ['TRACKING_PROJECT_ID', 'TRACKING_SALT', 'TRACKING_SINK_URL', 'TRACKING_SINK_TOKEN']
  );
  assert.equal(AUDIT_ROWS.find((row) => row.name === 'TRACKING_SINK_URL').teamInherited, true);
  assert.equal(AUDIT_ROWS.find((row) => row.name === 'TRACKING_SINK_TOKEN').teamInherited, true);
  assert.equal(AUDIT_ROWS.find((row) => row.name === 'TRACKING_SALT').cls, 'per-site');
  assert.equal(typeof AUDIT_ROWS.find((row) => row.name === 'TRACKING_SALT').generate, 'function');
});

test('listClientSlugs finds every real scaffolded tenant under sites/', () => {
  const slugs = listClientSlugs();
  for (const expected of ['drlurie', 'fernwell', 'platform', 'zilberman']) {
    assert.ok(slugs.includes(expected), `expected listClientSlugs() to include '${expected}', got: ${slugs.join(', ')}`);
  }
});

test('auditSiteEnv reports found:false when no matching Netlify site exists — not an error', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/sites?name=ghost')) return Response.json([]);
    return new Response(`unexpected: ${url}`, { status: 500 });
  };
  const result = await auditSiteEnv(fetchImpl, 'tok', 'ghost');
  assert.deepEqual(result, { clientSlug: 'ghost', found: false });
  assert.equal(renderSiteAuditReport(result), 'ghost:\n  (no matching Netlify site found — skipped)');
});

test('auditSiteEnv: inherited case — TRACKING_SINK_URL/TOKEN present at team level, TRACKING_PROJECT_ID present at site level, TRACKING_SALT present at site level — all ✓, correct level tags, no value anywhere', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/sites?name=acme')) {
      return Response.json([{ id: 'site-acme', account_id: 'acct-1', account_slug: 'team-1', name: 'acme' }]);
    }
    if (url.includes('/accounts/acct-1/env?site_id=site-acme')) {
      return Response.json([
        { key: 'TRACKING_PROJECT_ID', values: [{ context: 'all', value: SECRET_MARKER }] },
        { key: 'TRACKING_SALT', values: [{ context: 'all', value: SECRET_MARKER }] },
      ]);
    }
    if (url === 'https://api.netlify.com/api/v1/accounts/team-1/env') {
      return Response.json([
        { key: 'TRACKING_SINK_URL', values: [{ context: 'all', value: SECRET_MARKER }] },
        { key: 'TRACKING_SINK_TOKEN', values: [{ context: 'all', value: SECRET_MARKER }] },
      ]);
    }
    return new Response(`unexpected: ${url}`, { status: 500 });
  };

  const result = await auditSiteEnv(fetchImpl, 'tok', 'acme');
  assert.equal(result.found, true);
  assert.equal(result.checkError, undefined);
  assert.deepEqual(
    result.rows.map((row) => [row.name, row.present, row.level]),
    [
      ['TRACKING_PROJECT_ID', true, 'site'],
      ['TRACKING_SALT', true, 'site'],
      ['TRACKING_SINK_URL', true, 'team'],
      ['TRACKING_SINK_TOKEN', true, 'team'],
    ]
  );
  assert.equal(JSON.stringify(result).includes(SECRET_MARKER), false);

  const report = renderSiteAuditReport(result);
  assert.equal(report.includes(SECRET_MARKER), false);
  assert.equal(report, [
    'acme:',
    '  ✓ TRACKING_PROJECT_ID      [per-site]  set at site level',
    '  ✓ TRACKING_SALT            [per-site]  set at site level',
    '  ✓ TRACKING_SINK_URL        [fleet-shared]  inherited from team',
    '  ✓ TRACKING_SINK_TOKEN      [fleet-shared]  inherited from team',
  ].join('\n'));
});

test('auditSiteEnv: missing case — a site with nothing set reports all four ☐, and the report for a site missing TRACKING_SALT (with the others present) matches the pinned fixture verbatim', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/sites?name=acme')) {
      return Response.json([{ id: 'site-acme', account_id: 'acct-1', account_slug: 'team-1', name: 'acme' }]);
    }
    if (url.includes('/accounts/acct-1/env?site_id=site-acme')) {
      // TRACKING_PROJECT_ID present, TRACKING_SALT absent.
      return Response.json([{ key: 'TRACKING_PROJECT_ID', values: [{ context: 'all', value: SECRET_MARKER }] }]);
    }
    if (url === 'https://api.netlify.com/api/v1/accounts/team-1/env') {
      return Response.json([
        { key: 'TRACKING_SINK_URL', values: [{ context: 'all', value: SECRET_MARKER }] },
        { key: 'TRACKING_SINK_TOKEN', values: [{ context: 'all', value: SECRET_MARKER }] },
      ]);
    }
    return new Response(`unexpected: ${url}`, { status: 500 });
  };

  const result = await auditSiteEnv(fetchImpl, 'tok', 'acme');
  const report = renderSiteAuditReport(result);

  // Pinned fixture — this is the EXACT text `npm run env:audit` prints for a
  // site missing only TRACKING_SALT (R8 report item #4).
  const expected = [
    'acme:',
    '  ✓ TRACKING_PROJECT_ID      [per-site]  set at site level',
    '  ☐ TRACKING_SALT            [per-site]  missing — run with --fix to mint one',
    '  ✓ TRACKING_SINK_URL        [fleet-shared]  inherited from team',
    '  ✓ TRACKING_SINK_TOKEN      [fleet-shared]  inherited from team',
  ].join('\n');
  assert.equal(report, expected);
  assert.equal(report.includes(SECRET_MARKER), false);
});

test('auditSiteEnv: a fleet-shared row genuinely missing from the team reports the team-level fix instruction, never a site-level one', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/sites?name=acme')) {
      return Response.json([{ id: 'site-acme', account_id: 'acct-1', account_slug: 'team-1', name: 'acme' }]);
    }
    if (url.includes('/accounts/acct-1/env?site_id=site-acme')) return Response.json([]);
    if (url === 'https://api.netlify.com/api/v1/accounts/team-1/env') return Response.json([]);
    return new Response(`unexpected: ${url}`, { status: 500 });
  };
  const result = await auditSiteEnv(fetchImpl, 'tok', 'acme');
  const report = renderSiteAuditReport(result);
  assert.match(
    report,
    /☐ TRACKING_SINK_URL\s+\[fleet-shared\]\s+missing — add it as a TEAM-level env var \(Team → Environment variables; scope Functions, all contexts, all projects\), then re-run/
  );
  assert.match(
    report,
    /☐ TRACKING_SINK_TOKEN\s+\[fleet-shared\]\s+missing — add it as a TEAM-level env var \(Team → Environment variables; scope Functions, all contexts, all projects\), then re-run/
  );
});

test('auditSiteEnv reports checkError (fails closed) rather than crashing or claiming success when the live lookup errors', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/sites?name=acme')) {
      return Response.json([{ id: 'site-acme', account_id: 'acct-1', account_slug: 'team-1', name: 'acme' }]);
    }
    return new Response('service unavailable', { status: 503 });
  };
  const result = await auditSiteEnv(fetchImpl, 'tok', 'acme');
  assert.equal(result.found, true);
  assert.ok(result.checkError);
  assert.match(renderSiteAuditReport(result), /^acme:\n {2}⚠ could not verify — /);
});

test('fixSiteEnv mints TRACKING_SALT and sets TRACKING_PROJECT_ID to the client slug, writes NOTHING for the fleet-shared rows, and never returns/logs the minted value', async () => {
  const writes = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    if (url.endsWith('/sites?name=acme')) {
      return Response.json([{ id: 'site-acme', account_id: 'acct-1', account_slug: 'team-1', name: 'acme' }]);
    }
    if (method === 'GET' && url.includes('/accounts/acct-1/env?site_id=site-acme')) return Response.json([]);
    if (method === 'GET' && url === 'https://api.netlify.com/api/v1/accounts/team-1/env') {
      return Response.json([
        { key: 'TRACKING_SINK_URL', values: [{ context: 'all', value: SECRET_MARKER }] },
        { key: 'TRACKING_SINK_TOKEN', values: [{ context: 'all', value: SECRET_MARKER }] },
      ]);
    }
    if (method === 'GET' && url.includes('/accounts/acct-1/env/')) return new Response('', { status: 404 });
    if ((method === 'POST' || method === 'PUT') && url.includes('/accounts/acct-1/env')) {
      const parsed = JSON.parse(String(init.body));
      const variable = Array.isArray(parsed) ? parsed[0] : parsed;
      writes.push(variable);
      return Response.json(variable);
    }
    return new Response(`unexpected: ${method} ${url}`, { status: 500 });
  };

  const before = await auditSiteEnv(fetchImpl, 'tok', 'acme');
  assert.deepEqual(
    before.rows.filter((r) => !r.present).map((r) => r.name),
    ['TRACKING_PROJECT_ID', 'TRACKING_SALT']
  );

  const { fixed, failed } = await fixSiteEnv(fetchImpl, 'tok', before);
  assert.deepEqual(failed, []);
  assert.deepEqual(fixed.sort(), ['TRACKING_PROJECT_ID', 'TRACKING_SALT']);

  assert.equal(writes.length, 2);
  const projectIdWrite = writes.find((w) => w.key === 'TRACKING_PROJECT_ID');
  const saltWrite = writes.find((w) => w.key === 'TRACKING_SALT');
  assert.equal(projectIdWrite.values[0].value, 'acme');
  assert.equal(projectIdWrite.is_secret, undefined);
  assert.match(saltWrite.values[0].value, /^[0-9a-f]{64}$/, 'TRACKING_SALT must be a fresh random hex string, 32+ bytes');
  assert.equal(saltWrite.is_secret, true);
  // Never TRACKING_SINK_URL/TOKEN — the fleet-shared rows are never written by --fix.
  assert.equal(writes.some((w) => w.key === 'TRACKING_SINK_URL' || w.key === 'TRACKING_SINK_TOKEN'), false);
  assert.equal(JSON.stringify({ fixed, failed }).includes(SECRET_MARKER), false);
  assert.equal(JSON.stringify({ fixed, failed }).includes(saltWrite.values[0].value), false, 'the minted salt value must never be returned by fixSiteEnv');
});

test('fixSiteEnv is idempotent: re-auditing after a fix shows nothing missing, and fixing again writes nothing', async () => {
  const writes = [];
  let siteEnv = []; // mutated by successful writes, like a real site's env store would be
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    if (url.endsWith('/sites?name=acme')) {
      return Response.json([{ id: 'site-acme', account_id: 'acct-1', account_slug: 'team-1', name: 'acme' }]);
    }
    if (method === 'GET' && url.includes('/accounts/acct-1/env?site_id=site-acme')) return Response.json(siteEnv);
    if (method === 'GET' && url === 'https://api.netlify.com/api/v1/accounts/team-1/env') {
      return Response.json([{ key: 'TRACKING_SINK_URL', values: [] }, { key: 'TRACKING_SINK_TOKEN', values: [] }]);
    }
    if (method === 'GET' && url.includes('/accounts/acct-1/env/')) return new Response('', { status: 404 });
    if (method === 'POST' && url.includes('/accounts/acct-1/env')) {
      const parsed = JSON.parse(String(init.body));
      const variable = Array.isArray(parsed) ? parsed[0] : parsed;
      writes.push(variable);
      siteEnv = [...siteEnv, { key: variable.key, values: variable.values }];
      return Response.json(variable);
    }
    return new Response(`unexpected: ${method} ${url}`, { status: 500 });
  };

  const first = await auditSiteEnv(fetchImpl, 'tok', 'acme');
  const firstFix = await fixSiteEnv(fetchImpl, 'tok', first);
  assert.deepEqual(firstFix.fixed.sort(), ['TRACKING_PROJECT_ID', 'TRACKING_SALT']);
  assert.equal(writes.length, 2);

  const second = await auditSiteEnv(fetchImpl, 'tok', 'acme');
  assert.deepEqual(
    second.rows.filter((r) => r.cls === 'per-site').map((r) => r.present),
    [true, true]
  );
  const secondFix = await fixSiteEnv(fetchImpl, 'tok', second);
  assert.deepEqual(secondFix.fixed, []);
  assert.deepEqual(secondFix.failed, []);
  assert.equal(writes.length, 2, 'a second --fix must write nothing new — idempotent');
});

test('main(): exits 2 with a clear stderr message (no crash) when NETLIFY_AUTH_TOKEN is absent', async () => {
  const { outLines, errLines, returned } = await captureConsole(() => main([], { tokenEnv: {} }));
  assert.equal(returned, 2);
  assert.equal(outLines.length, 0);
  assert.equal(errLines.length, 1);
  assert.match(errLines[0], /NETLIFY_AUTH_TOKEN is not set/);
});

test('main(): exits 1 and prints the per-site report when a row is missing; exits 0 once --fix has resolved it', async () => {
  let siteEnv = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    if (url.endsWith('/sites?name=acme')) {
      return Response.json([{ id: 'site-acme', account_id: 'acct-1', account_slug: 'team-1', name: 'acme' }]);
    }
    if (method === 'GET' && url.includes('/accounts/acct-1/env?site_id=site-acme')) return Response.json(siteEnv);
    if (method === 'GET' && url === 'https://api.netlify.com/api/v1/accounts/team-1/env') {
      return Response.json([{ key: 'TRACKING_SINK_URL', values: [] }, { key: 'TRACKING_SINK_TOKEN', values: [] }]);
    }
    if (method === 'GET' && url.includes('/accounts/acct-1/env/')) return new Response('', { status: 404 });
    if (method === 'POST' && url.includes('/accounts/acct-1/env')) {
      const parsed = JSON.parse(String(init.body));
      const variable = Array.isArray(parsed) ? parsed[0] : parsed;
      siteEnv = [...siteEnv, { key: variable.key, values: variable.values }];
      return Response.json(variable);
    }
    return new Response(`unexpected: ${method} ${url}`, { status: 500 });
  };

  const withoutFix = await captureConsole(() =>
    main(['--site', 'acme'], { fetchImpl, tokenEnv: { NETLIFY_AUTH_TOKEN: 'tok' } })
  );
  assert.equal(withoutFix.returned, 1);
  assert.ok(withoutFix.outLines.some((l) => l.includes('☐ TRACKING_SALT')));

  const withFix = await captureConsole(() =>
    main(['--site', 'acme', '--fix'], { fetchImpl, tokenEnv: { NETLIFY_AUTH_TOKEN: 'tok' } })
  );
  assert.equal(withFix.returned, 0);
  assert.ok(withFix.outLines.some((l) => l.includes('✓ TRACKING_SALT')));
  assert.ok(withFix.outLines.some((l) => l.includes('✓ TRACKING_PROJECT_ID')));

  // Nothing printed by either run ever carries a hex-looking secret value.
  for (const line of [...withoutFix.outLines, ...withFix.outLines]) {
    assert.equal(/\b[0-9a-f]{32,}\b/i.test(line), false, `line must not carry a secret-shaped value: ${line}`);
  }
});
