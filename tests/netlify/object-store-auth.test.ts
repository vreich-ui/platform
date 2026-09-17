import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { handler as adminObjectHandler } from '../../netlify/functions/admin-object.js';
import { handler as objectStoreHandler } from '../../netlify/functions/object-store.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import type { ObjectRecord } from '../../packages/core/schema/object-record-v1.js';

/**
 * Repo root, anchored to this test file's own compiled location rather than
 * `process.cwd()` — the CI test runner compiles the whole suite to a temp
 * outDir and invokes `node --test` from there (needed for its recursive
 * discovery), so `process.cwd()` is NOT the repo root at test time. The
 * source-scan tests below read actual .ts SOURCE files (never emitted into
 * outDir), so they must resolve the real repo root regardless of run cwd.
 */
const findRepoRoot = (startDir: string): string => {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'astro.config.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not locate repo root (no ancestor with astro.config.ts).');
    dir = parent;
  }
};
const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

// End-to-end tests of BOTH auth entry points against the local blob fallback.
// Neither NETLIFY runtime env is set and events carry no blob context, so
// getSiteObjectsBlobStore falls back to the file-backed local store.
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
const PUBLISH_SECRET = 'test-publish-secret';
process.env.PUBLISH_SECRET = PUBLISH_SECRET;
process.env.ADMIN_EMAILS = 'admin@drlurie.com';

// Isolated from the default .netlify/local-blobs root: this suite and its siblings
// (object-lifecycle.e2e.test.ts, mcp-object-tools.test.ts) all exercise the site-objects
// local fallback store, and node:test runs separate test files concurrently, so sharing
// one on-disk directory raced resets against reads/writes across files.
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'object-store-auth');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);
const SITE_OBJECTS_DIR = join(LOCAL_BLOBS_ROOT, 'site-objects');
const reset = () => rm(SITE_OBJECTS_DIR, { recursive: true, force: true });

const validPageBody = () => ({
  route: '/',
  pageType: 'home',
  title: 'Dr. Lurié',
  seo: { description: 'Science-first skincare.' },
  sections: [{ id: 's_hero', type: 'hero', data: { heading: 'Hi', actions: [] } }],
});

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  httpMethod: 'POST',
  headers,
  body: JSON.stringify(body),
});

const parse = (response: { statusCode: number; body: string }) => ({
  status: response.statusCode,
  json: JSON.parse(response.body) as Record<string, unknown>,
});

// ═══ object-store.ts (publish-key path) ══════════════════════════════════════

test('object-store: rejects non-POST with 405', async () => {
  const res = parse(await objectStoreHandler({ httpMethod: 'GET' }));
  assert.equal(res.status, 405);
});

test('object-store: 401 when the publish key is missing or wrong', async () => {
  const missing = parse(await objectStoreHandler(post({ action: 'get', object_type: 'page', object_id: 'page_x' })));
  assert.equal(missing.status, 401);
  const wrong = parse(
    await objectStoreHandler(
      post({ action: 'get', object_type: 'page', object_id: 'page_x' }, { 'x-publish-key': 'nope' })
    )
  );
  assert.equal(wrong.status, 401);
});

test('object-store: with a valid publish key, an agent creates a record end-to-end', async () => {
  await reset();
  const res = parse(
    await objectStoreHandler(
      post(
        {
          action: 'create',
          object_type: 'page',
          site: 'site_drlurie',
          body: validPageBody(),
          requested_id: 'page_home',
          agent_name: 'smoke-agent',
        },
        { 'x-publish-key': PUBLISH_SECRET }
      )
    )
  );
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const record = res.json.record as ObjectRecord;
  assert.equal(record.object_id, 'page_home');
  assert.equal(record.history[0].actor.kind, 'agent');
  assert.equal((record.history[0].actor as { agent_name: string }).agent_name, 'smoke-agent');
});

// ═══ admin-object.ts (Netlify Identity path) ═════════════════════════════════

const adminContext = (email: string) => ({ clientContext: { user: { sub: 'identity-user', email } } });

test('admin-object: rejects non-POST with 405', async () => {
  const res = parse(await adminObjectHandler({ httpMethod: 'GET' }));
  assert.equal(res.status, 405);
});

test('admin-object: 401 unauthenticated, 403 for a non-admin identity', async () => {
  const anon = parse(await adminObjectHandler(post({ action: 'get', object_type: 'page', object_id: 'page_x' })));
  assert.equal(anon.status, 401);
  const nonAdmin = parse(
    await adminObjectHandler(
      post({ action: 'get', object_type: 'page', object_id: 'page_x' }),
      adminContext('nobody@example.com')
    )
  );
  assert.equal(nonAdmin.status, 403);
});

test('admin-object: an admin creates a record with NO publish key present (identity only)', async () => {
  await reset();
  const res = parse(
    await adminObjectHandler(
      // Note: no x-publish-key header anywhere on this request.
      post({
        action: 'create',
        object_type: 'page',
        site: 'site_drlurie',
        body: validPageBody(),
        requested_id: 'page_home',
      }),
      adminContext('admin@drlurie.com')
    )
  );
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const record = res.json.record as ObjectRecord;
  assert.equal(record.history[0].actor.kind, 'human');
  assert.equal((record.history[0].actor as { email: string }).email, 'admin@drlurie.com');
});

test('both paths share one store: an agent-created record is readable through the admin path', async () => {
  await reset();
  await objectStoreHandler(
    post(
      { action: 'create', object_type: 'page', site: 'site_drlurie', body: validPageBody(), requested_id: 'page_home' },
      { 'x-publish-key': PUBLISH_SECRET }
    )
  );
  const got = parse(
    await adminObjectHandler(
      post({ action: 'get', object_type: 'page', object_id: 'page_home' }),
      adminContext('admin@drlurie.com')
    )
  );
  assert.equal(got.status, 200);
  assert.equal((got.json.record as ObjectRecord).object_id, 'page_home');
});

// ═══ security invariant: the browser path never sees the publish key ═════════

test('admin-object source references the publish key nowhere (never receives/reads/forwards it)', () => {
  const source = readFileSync(join(REPO_ROOT, 'packages/core/server/functions/admin-object.ts'), 'utf8');
  // Allow the doc-comment sentence that NAMES the invariant; strip comments first.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/PUBLISH_SECRET/i.test(code), 'admin-object must not reference PUBLISH_SECRET');
  assert.ok(!/x-publish-key/i.test(code), 'admin-object must not read the x-publish-key header');
  assert.ok(!/verifyPublishKey|secretsMatch/i.test(code), 'admin-object must not run publish-key auth');
});

// ═══ minting is centralized in one helper, not inlined per action ════════════

test('object-verbs mints only through the shared mintId helper (no inline id generation)', () => {
  const source = readFileSync(join(REPO_ROOT, 'packages/core/server/lib/object-verbs.ts'), 'utf8');
  assert.ok(
    /from '\.\.\/\.\.\/lib\/object-ids-mint\.js'/.test(source),
    'must import the shared mintId helper',
  );
  assert.ok(/mintId\(/.test(source), 'must call mintId');
  assert.ok(!/randomUUID/.test(source), 'no inline UUID id generation');
  assert.ok(!/createHash/.test(source), 'no inline hashing — that belongs to mintId');
});

// ═══ M3.3: the visual-identity snapshot action ══════════════════════════════

/**
 * `admin-object{action:'visual_identity_snapshot'}` is the ONE call that
 * replaced seventeen on `/admin/settings/visual-identity` (four `list`s and a
 * `get` per id across `template`, `section_template`, `theme` and
 * `visual_standard`). It is handled ahead of the verb schema, so these cases
 * exist to prove it did not step outside this function's auth gate on the way:
 * it is the same 401, the same 403, and it grants exactly what those seventeen
 * admin reads granted, never more.
 *
 * Note which store this runs against: the local file-backed shim, which
 * reports no etags. The snapshot can therefore never be TRUSTED here and every
 * call rebuilds from the records — the documented degradation
 * (`visual-identity/snapshot-doc.ts`), and the honest thing for this file to
 * exercise, because it proves the repair path answers correctly on its own.
 */
const visualIdentityThemeBody = () => ({
  name: 'Editorial airy',
  description: 'A token-axis demonstration preset, created to prove the snapshot action carries bodies.',
  whenToUse: 'Apply to preview the design axes on the live palette; revert with the default theme.',
  scope: 'evergreen',
  tokens: {
    colors: { ink: '#111111', paper: '#ffffff' },
    fonts: { sans: 'Inter', serif: 'Lora', heading: 'Inter' },
  },
});

test('admin-object: the visual-identity snapshot is 401 unauthenticated and 403 for a non-admin identity', async () => {
  const anon = parse(await adminObjectHandler(post({ action: 'visual_identity_snapshot' })));
  assert.equal(anon.status, 401);
  const nonAdmin = parse(
    await adminObjectHandler(post({ action: 'visual_identity_snapshot' }), adminContext('nobody@example.com'))
  );
  assert.equal(nonAdmin.status, 403);
});

test('admin-object: ONE snapshot call answers the four collections the seventeen reads used to', async () => {
  await reset();
  const created = parse(
    await adminObjectHandler(
      post({
        action: 'create',
        object_type: 'theme',
        site: 'site_drlurie',
        body: visualIdentityThemeBody(),
        requested_id: 'thm_drlurie_airy',
      }),
      adminContext('admin@drlurie.com')
    )
  );
  assert.equal(created.status, 200, JSON.stringify(created.json));

  const snapshot = parse(
    await adminObjectHandler(post({ action: 'visual_identity_snapshot' }), adminContext('admin@drlurie.com'))
  );
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.json));
  const records = snapshot.json.records as Record<string, ObjectRecord[]>;
  assert.deepEqual(Object.keys(records).sort(), ['section_template', 'template', 'theme', 'visual_standard']);
  assert.equal(records.theme?.length, 1);
  const theme = records.theme?.[0] as ObjectRecord;
  assert.equal(theme.object_id, 'thm_drlurie_airy');
  // The BODY is there — that is the whole point; a summary row would have made
  // the page fetch every record anyway.
  assert.equal((theme.body as { name: string }).name, 'Editorial airy');
  // …and the ledger is not, with its length kept so nothing is pretended.
  assert.deepEqual(theme.history, []);
  assert.equal((theme as unknown as { history_length: number }).history_length, 1);
  assert.equal(typeof snapshot.json.as_of, 'string');
});
