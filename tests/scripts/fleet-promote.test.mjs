import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildHookEnvName, FLEET_SLUGS, main, parseArgs, promoteSite } from '../../scripts/fleet-promote.mjs';

// cloud-cost N1. Production builds are skipped from git on every fleet site, so this
// script is the ONLY way code reaches production. A bug here is not a cosmetic one:
// it is a site that quietly stops shipping.

test('every fleet site is promotable, and the env name is derived, not hand-maintained', () => {
  assert.ok(FLEET_SLUGS.includes('genesis-lab-2'), 'the fifth tenant must be in the promote map');
  assert.equal(buildHookEnvName('genesis-lab-2'), 'NETLIFY_BUILD_HOOK_URL__GENESIS_LAB_2');
  assert.equal(buildHookEnvName('drlurie'), 'NETLIFY_BUILD_HOOK_URL__DRLURIE');
});

test('a typo is refused before anything is spent', () => {
  assert.match(parseArgs(['--site', 'genesis-lab']).error, /unknown site/);
  assert.match(parseArgs([]).error, /--all or --site/);
  assert.match(parseArgs(['--all', '--site', 'fernwell']).error, /mutually exclusive/);
  assert.deepEqual(parseArgs(['--site', 'fernwell']).targets, ['fernwell']);
  assert.deepEqual(parseArgs(['--all']).targets, FLEET_SLUGS);
});

test('an unconfigured site fails by name instead of promoting nothing silently', async () => {
  const result = await promoteSite('fernwell', { env: {}, fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_configured');
  assert.match(result.detail, /NETLIFY_BUILD_HOOK_URL__FERNWELL/);
});

test('the hook URL is never echoed, even when the request fails', async () => {
  const url = 'https://api.netlify.com/build_hooks/SECRET123';
  const result = await promoteSite('fernwell', {
    env: { NETLIFY_BUILD_HOOK_URL__FERNWELL: url },
    fetchImpl: async () => { throw new Error(`connect ECONNREFUSED ${url}`); },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.detail.includes('SECRET123'), 'a build hook URL is a bearer credential and must not be logged');
});

test('--all promotes every site and reports a failure without abandoning the rest', async () => {
  const posted = [];
  const env = Object.fromEntries(FLEET_SLUGS.map((slug) => [buildHookEnvName(slug), `https://hook.example/${slug}`]));
  delete env[buildHookEnvName('zilberman')];
  const lines = [];
  const code = await main(['--all'], {
    env,
    log: (line) => lines.push(line),
    fetchImpl: async (target) => {
      posted.push(target);
      return { ok: !target.endsWith('/fernwell'), status: target.endsWith('/fernwell') ? 500 : 200 };
    },
  });

  // Four hooks fired (zilberman had no URL), and the two failures did not stop the others.
  assert.equal(posted.length, FLEET_SLUGS.length - 1);
  assert.equal(code, 1, 'a partial promote must fail the command');
  assert.ok(lines.some((line) => line.includes('zilberman') && line.includes('not_configured')));
  assert.ok(lines.some((line) => line.includes('fernwell') && line.includes('hook_rejected')));
  assert.ok(lines.some((line) => line.includes('genesis-lab-2') && line.includes('queued')));
});

test('a clean --all promote exits 0', async () => {
  const env = Object.fromEntries(FLEET_SLUGS.map((slug) => [buildHookEnvName(slug), `https://hook.example/${slug}`]));
  const code = await main(['--all'], { env, log: () => {}, fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(code, 0);
});

test('every fleet netlify.toml carries the production gate ahead of its path diff', () => {
  const tomls = [
    'netlify.toml',
    ...FLEET_SLUGS.filter((slug) => slug !== 'drlurie').map((slug) => `sites/${slug}/netlify.toml`),
  ];
  for (const file of tomls) {
    const ignoreLine = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
      .split('\n')
      .find((line) => /^\s*ignore\s*=/.test(line));
    assert.ok(ignoreLine, `${file} must have an ignore command — without one every main push builds it`);
    assert.match(ignoreLine, /\$CONTEXT/, `${file} production gate must test $CONTEXT`);
    assert.match(ignoreLine, /\$BRANCH/, `${file} production gate must test $BRANCH`);
    assert.match(ignoreLine, /exit 0/, `${file} gate must skip on production`);
    const diffAt = ignoreLine.indexOf('diff --quiet');
    if (diffAt > -1) assert.ok(ignoreLine.indexOf('$CONTEXT') < diffAt, `${file}: the gate must precede the path diff`);
  }
});
