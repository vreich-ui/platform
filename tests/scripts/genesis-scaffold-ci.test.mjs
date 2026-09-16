import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

/** ASYNC, and it has to be: execFileSync blocks this process's event loop, so the stub server below
 *  could never answer the child it just spawned — a deadlock, not a failure. */
const execFileAsync = promisify(execFile);
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyScaffoldChanges, parsePorcelain } from '../../scripts/ci/genesis-scaffold-guard.mjs';

/**
 * G2 — the genesis-scaffold job's charter guard.
 *
 * The job itself cannot be unit-tested (it needs a runner, a real npm install and a push), so what
 * is tested is the thing that actually protects the repo. This job is the only workflow here that
 * commits to `main` under a dispatch from another system; capture-preview's equivalent discipline is
 * a script asserting it published nothing, and this is ours.
 *
 * The guard is a DENY-list failure away from being useless, so every test below is a way a dispatch
 * could reach a path it has no business touching.
 */

const entry = (code, filePath) => ({ code, path: filePath });
const scaffoldOf = (slug, count = 3) =>
  Array.from({ length: count }, (_, index) => entry('??', `sites/${slug}/file-${index}.ts`));
const lockfile = entry(' M', 'package-lock.json');
const inventory = entry(' M', 'docs/generated/INVENTORY.md');

test('accepts exactly one new tenant plus the two generated artifacts it changes', () => {
  const result = classifyScaffoldChanges('acme-labs', [...scaffoldOf('acme-labs'), lockfile, inventory]);
  assert.equal(result.ok, true, result.violations.join('; '));
  assert.equal(result.siteFiles, 3);
});

test('accepts a scaffold that did not move the inventory, but never one that did not move the lockfile', () => {
  // The charter is a CEILING for the inventory and a FLOOR for the lockfile. A new site is a new npm
  // workspace: committing the tree with a stale root lockfile fails every `npm ci` in the fleet,
  // which is the same outcome the charter exists to prevent — just reached by omission.
  assert.equal(classifyScaffoldChanges('acme', [...scaffoldOf('acme', 1), lockfile]).ok, true);

  const noLockfile = classifyScaffoldChanges('acme', scaffoldOf('acme', 1));
  assert.equal(noLockfile.ok, false);
  assert.match(noLockfile.violations.join(' '), /package-lock\.json did not change/);
});

test('REFUSES a DELETION of the two paths it may otherwise modify', () => {
  // The charter says MODIFIED. Deleting the root lockfile breaks npm ci for the entire fleet, and
  // `git add package-lock.json` in the commit step would stage exactly that deletion.
  for (const path of ['package-lock.json', 'docs/generated/INVENTORY.md']) {
    const result = classifyScaffoldChanges('acme', [...scaffoldOf('acme'), lockfile, entry(' D', path)]);
    assert.equal(result.ok, false, `deleting ${path} must be refused`);
    assert.match(result.violations.join(' '), /DELETED|did not change/);
  }
});

test('parsePorcelain consumes a rename\'s second record instead of reading it as a status code', () => {
  // `-z` emits the ORIGINAL path of a rename as its own record with NO status prefix. Parsed
  // naively, "sites/old/x.ts" becomes code "si" and path "es/old/x.ts" — a violation that names a
  // path nobody can find.
  const parsed = parsePorcelain('R  sites/new/x.ts\0sites/old/x.ts\0 M package-lock.json\0');
  assert.deepEqual(parsed.map((item) => item.path), ['sites/new/x.ts', 'sites/old/x.ts', 'package-lock.json']);
  assert.equal(classifyScaffoldChanges('new', parsed).ok, false);
});

test('REFUSES a change to any path outside the charter', () => {
  // The whole point. A dispatch that could edit packages/core, a workflow file, or another tenant
  // would be a remote-code-execution path into the fleet wearing a scaffold's clothes.
  for (const outside of ['packages/core/lib/object-ids.ts', '.github/workflows/actions.yaml', 'sites/drlurie/site.config.ts', 'netlify.toml']) {
    const result = classifyScaffoldChanges('acme', [...scaffoldOf('acme'), entry(' M', outside)]);
    assert.equal(result.ok, false, `${outside} must be refused`);
    assert.match(result.violations.join(' '), /outside this job's charter/);
  }
});

test('REFUSES a deletion, even inside the new tenant tree', () => {
  const result = classifyScaffoldChanges('acme', [...scaffoldOf('acme'), entry(' D', 'sites/acme/site.config.ts')]);
  assert.equal(result.ok, false);
});

test('REFUSES a MODIFIED file inside the tenant tree — the slug already existed', () => {
  // create-site is idempotent: it leaves an existing tree untouched. So a modified file under
  // sites/<slug>/ means something other than a scaffold produced it.
  const result = classifyScaffoldChanges('acme', [entry(' M', 'sites/acme/site.config.ts'), lockfile]);
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /may only be ADDED/);
});

test('REFUSES when the scaffold produced no tenant files at all', () => {
  // Otherwise an empty scaffold commits a lockfile churn under a tenant's name and reports success.
  const result = classifyScaffoldChanges('acme', [lockfile, inventory]);
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /produced nothing/);
});

test('REFUSES a slug that is not a legal object-id slug, before looking at any path', () => {
  // A slug reaches this from a dispatch input. Path traversal and shell metacharacters both die here.
  for (const slug of ['../../etc', 'Acme', 'acme_labs', 'acme/../drlurie', '', 'acme; rm -rf /', 'a', '9lives', 'x'.repeat(32)]) {
    assert.equal(classifyScaffoldChanges(slug, scaffoldOf(slug)).ok, false, `${slug} must be refused`);
  }
});

test('a tenant slug that PREFIXES another cannot smuggle in the other tenant', () => {
  // "sites/acme" is not a prefix of "sites/acme-labs/..." once the separator is part of the prefix —
  // the guard compares against `sites/<slug>/`, and this pins that it stays that way.
  const result = classifyScaffoldChanges('acme', [...scaffoldOf('acme'), entry('??', 'sites/acme-labs/site.config.ts')]);
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /outside this job's charter/);
});

test('parsePorcelain keeps a path containing a space in one piece', () => {
  // -z exists precisely so a filename cannot split an entry; a line-based parser would read
  // "sites/acme/a b.ts" as two paths and wave one of them through.
  const parsed = parsePorcelain('?? sites/acme/a b.ts\0 M package-lock.json\0');
  assert.deepEqual(parsed, [
    { code: '??', path: 'sites/acme/a b.ts' },
    { code: ' M', path: 'package-lock.json' },
  ]);
});

test('the guard script exits non-zero against a real repo with an out-of-charter change', async () => {
  // End to end through git itself, because the porcelain format is the one contract here that a
  // hand-written fixture could quietly get wrong.
  const repo = await mkdtemp(path.join(tmpdir(), 'genesis-guard-'));
  const guard = fileURLToPath(new URL('../../scripts/ci/genesis-scaffold-guard.mjs', import.meta.url));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    await writeFile(path.join(repo, 'package-lock.json'), '{}\n');
    git('add', '.');
    git('commit', '-qm', 'base');

    await mkdir(path.join(repo, 'sites/acme'), { recursive: true });
    await writeFile(path.join(repo, 'sites/acme/site.config.ts'), 'export default {};\n');
    await writeFile(path.join(repo, 'package-lock.json'), '{"a":1}\n');

    const run = () => execFileSync('node', [guard], { cwd: repo, env: { ...process.env, GENESIS_SLUG: 'acme' }, encoding: 'utf8' });
    assert.match(run(), /OK — 1 file/);

    // And the floor, through real git: revert the lockfile and the same tree is refused.
    await writeFile(path.join(repo, 'package-lock.json'), '{}\n');
    assert.throws(run, /did not change/);
    await writeFile(path.join(repo, 'package-lock.json'), '{"a":1}\n');

    // Now add the thing the charter exists to stop.
    await mkdir(path.join(repo, 'packages/core'), { recursive: true });
    await writeFile(path.join(repo, 'packages/core/evil.ts'), 'export {};\n');
    assert.throws(run, /charter|Refusing/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * A stub GitHub API. The blob transport is the part of this design most easily got wrong: the blob
 * cms-agent creates is UNREFERENCED, so it is on the SERVER and never in the runner's .git — an
 * earlier version of these scripts read it with `git cat-file` and would have failed every mint that
 * carried an artifact, with a test that passed because the fixture was hashed locally.
 */
const stubGitHub = async (handler) => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => handler(request, body, response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    // closeAllConnections first: undici keeps the socket alive, and server.close() alone waits for
    // it forever — the test hangs rather than failing, which is the worst way for one to be wrong.
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
};

test('the inputs script reads the blob FROM THE API and writes a NUL-separated argv', async () => {
  // NUL-separated because `${VAR:+--flag "$VAR"}` word-splits AFTER expansion — a brand name of
  // "Acme Labs" arrives as two arguments. These values are caller-influenced, so nothing here may
  // depend on a shell's word splitting to stay correct.
  const sha = 'a'.repeat(40);
  const requested = [];
  const api = await stubGitHub((request, _body, response) => {
    requested.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      encoding: 'base64',
      content: Buffer.from(JSON.stringify({ editorialVoice: { name: 'v' }, logo: { svg: '<svg/>' }, ignored: 1 })).toString('base64'),
    }));
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'genesis-inputs-'));
  const script = fileURLToPath(new URL('../../scripts/ci/genesis-scaffold-inputs.mjs', import.meta.url));
  const env = { ...process.env, GH_TOKEN: 't', REPOSITORY: 'vreich-ui/platform', GITHUB_API_URL: api.url, GENESIS_ARTIFACTS_BLOB: sha };
  try {
    await execFileAsync('node', [script], { cwd: dir, env });
    assert.deepEqual(requested, [`/repos/vreich-ui/platform/git/blobs/${sha}`]);

    const argv = (await readFile(path.join(dir, '.tmp/genesis/artifact-args'), 'utf8')).split('\0').filter(Boolean);
    // Only the keys the CLI knows; `ignored` never becomes a flag.
    assert.deepEqual(argv, ['--editorial-voice', '@.tmp/genesis/artifacts/editorialVoice.json', '--logo', '@.tmp/genesis/artifacts/logo.json']);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, '.tmp/genesis/artifacts/editorialVoice.json'), 'utf8')), { name: 'v' });

    // No blob = no flags, and an EMPTY file rather than none: the scaffold step tests for -s.
    await execFileAsync('node', [script], { cwd: dir, env: { ...env, GENESIS_ARTIFACTS_BLOB: '' } });
    assert.equal(await readFile(path.join(dir, '.tmp/genesis/artifact-args'), 'utf8'), '');
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the inputs script FAILS the job when the blob cannot be read, rather than scaffolding without it', async () => {
  // The fleet genesis policy can REQUIRE an artifact. Silently continuing would mint a tenant with
  // placeholder objects that the policy exists to forbid.
  const api = await stubGitHub((_request, _body, response) => { response.writeHead(404); response.end('{}'); });
  const dir = await mkdtemp(path.join(tmpdir(), 'genesis-inputs-404-'));
  const script = fileURLToPath(new URL('../../scripts/ci/genesis-scaffold-inputs.mjs', import.meta.url));
  try {
    await assert.rejects(
      execFileAsync('node', [script], {
        cwd: dir,
        env: { ...process.env, GH_TOKEN: 't', REPOSITORY: 'r/r', GITHUB_API_URL: api.url, GENESIS_ARTIFACTS_BLOB: 'b'.repeat(40) },
      }));
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the report script publishes the result blob TO THE API, carrying a refusal verbatim', async () => {
  // The refusal carry-back is the whole reason this document exists. A locally hashed object lives
  // only on the ephemeral runner, so the dispatcher would 404 and every named refusal would reach
  // the operator as an opaque "the job concluded failure".
  const posted = [];
  const api = await stubGitHub((request, body, response) => {
    posted.push({ url: request.url, body: JSON.parse(body) });
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ sha: 'c'.repeat(40) }));
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'genesis-report-'));
  const script = fileURLToPath(new URL('../../scripts/ci/genesis-scaffold-report.mjs', import.meta.url));
  const refusal = { error_code: 'genesis_artifact_required', missing: ['editorialVoice'] };
  try {
    await mkdir(path.join(dir, '.tmp/genesis'), { recursive: true });
    await writeFile(path.join(dir, '.tmp/genesis/create-site-result.json'), JSON.stringify(refusal));
    const githubEnv = path.join(dir, 'github.env');
    await writeFile(githubEnv, '');

    await execFileAsync('node', [script], {
      cwd: dir,
      env: { ...process.env, GH_TOKEN: 't', REPOSITORY: 'r/r', GITHUB_API_URL: api.url, GENESIS_SLUG: 'acme', GENESIS_JOB_STATUS: 'failure', GITHUB_ENV: githubEnv },
    });

    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, '/repos/r/r/git/blobs');
    const published = JSON.parse(Buffer.from(posted[0].body.content, 'base64').toString('utf8'));
    assert.equal(published.status, 'failed');
    assert.deepEqual(published.refusal, refusal);

    // The sha reaches the next step through GITHUB_ENV, which is what names the marker artifact.
    assert.match(await readFile(githubEnv, 'utf8'), new RegExp(`GENESIS_REPORT_BLOB_SHA=${'c'.repeat(40)}`));
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the inputs script refuses anything that is not a blob sha', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'genesis-inputs-bad-'));
  const script = fileURLToPath(new URL('../../scripts/ci/genesis-scaffold-inputs.mjs', import.meta.url));
  try {
    execFileSync('git', ['-C', repo, 'init', '-q']);
    for (const bad of ['HEAD', '../../etc/passwd', '$(whoami)', 'deadbeef']) {
      assert.throws(
        () => execFileSync('node', [script], { cwd: repo, env: { ...process.env, GENESIS_ARTIFACTS_BLOB: bad }, stdio: 'pipe' }),
        `${bad} must be refused`,
      );
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
