import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { handler as manifestHandler } from '../../netlify/functions/admin-plugin-manifest.js';
import { getGovernanceBlobStore } from '../../packages/core/server/lib/governance-store.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { putAccessTokenRecord, type OAuthBlobStore } from '../../packages/core/server/lib/oauth-store.js';
import {
  emptyInstallSignalsDoc,
  latestSignalAt,
  MAX_TRACKED_MEMBERS,
  withRecordedWhoami,
} from '../../packages/core/server/lib/plugin/install-signals.js';
import { installerRows, type InstallersBoard } from '../../packages/core/lib/admin/plugins-client.js';

/**
 * W7.6 acceptance — the operator can answer "did it work?" without asking.
 *
 * The signal is `whoami`, and it is a good signal because it costs the
 * installer nothing extra: the skill calls it at session start and the install
 * page's last step is running it, so a working install produces one by
 * construction. A member with no signal has not finished installing — which is
 * a far more useful thing for an owner to know than "invited".
 */
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';
process.env.MCP_HTTP_AUTH_TOKEN = 'a-shared-secret';
process.env.ADMIN_EMAILS = 'owner@example.com';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'plugin-install-signals');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

const HEADERS = {
  host: 'drluriescience.netlify.app',
  'x-forwarded-proto': 'https',
  'content-type': 'application/json',
};
const OWNER = { clientContext: { user: { sub: 'usr_owner', email: 'owner@example.com' } } };

// ─── the fold ────────────────────────────────────────────────────────────────

test('a whoami is recorded per member AND per surface — one person, two installs', () => {
  const at = '2026-09-04T12:00:00.000Z';
  let doc = withRecordedWhoami(emptyInstallSignalsDoc(), {
    email: 'Editor@Example.com',
    surface: 'plugin:claude',
    manifestVersion: 'm1',
    toolsDigest: 'sha_1_49',
    canWrite: true,
    at,
  });
  doc = withRecordedWhoami(doc, {
    email: 'editor@example.com',
    surface: 'plugin:openai-gpt',
    manifestVersion: 'm1',
    toolsDigest: 'sha_1_49',
    canWrite: true,
    at: '2026-09-04T13:00:00.000Z',
  });

  // The e-mail is the key, normalized: one person, not two.
  assert.deepEqual(Object.keys(doc.members), ['editor@example.com']);
  assert.deepEqual(Object.keys(doc.members['editor@example.com']).sort(), ['plugin:claude', 'plugin:openai-gpt']);
  assert.equal(latestSignalAt(doc.members['editor@example.com']), '2026-09-04T13:00:00.000Z');
});

test('repeat sessions count, so a one-off probe reads differently from daily use', () => {
  let doc = emptyInstallSignalsDoc();
  for (let i = 0; i < 3; i += 1) {
    doc = withRecordedWhoami(doc, {
      email: 'e@x.com',
      surface: 'plugin:claude',
      manifestVersion: 'm1',
      toolsDigest: 'd',
      canWrite: true,
      at: `2026-09-0${i + 1}T00:00:00.000Z`,
    });
  }
  assert.equal(doc.members['e@x.com']['plugin:claude'].count, 3);
  assert.equal(doc.members['e@x.com']['plugin:claude'].last_whoami_at, '2026-09-03T00:00:00.000Z');
});

test('the board is bounded — it must stay loadable on every page open', () => {
  let doc = emptyInstallSignalsDoc();
  for (let i = 0; i < MAX_TRACKED_MEMBERS + 20; i += 1) {
    doc = withRecordedWhoami(doc, {
      email: `member${String(i).padStart(3, '0')}@x.com`,
      surface: 'plugin:claude',
      manifestVersion: 'm1',
      toolsDigest: 'd',
      canWrite: true,
      // Ascending, so the LAST ones written are the newest.
      at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 60_000).toISOString(),
    });
  }
  assert.equal(Object.keys(doc.members).length, MAX_TRACKED_MEMBERS);
  // Oldest evicted, newest kept: the interesting end survives.
  assert.ok(!doc.members['member000@x.com']);
  assert.ok(doc.members[`member${String(MAX_TRACKED_MEMBERS + 19).padStart(3, '0')}@x.com`]);
});

// ─── the rows an operator reads ──────────────────────────────────────────────

test('staleness is computed against the LIVE manifest, not trusted from the signal', () => {
  const board: InstallersBoard = {
    signals: {
      'current@x.com': {
        'plugin:claude': {
          last_whoami_at: '2026-09-04T12:00:00.000Z',
          manifest_version: 'm2',
          tools_digest: 'd',
          can_write: true,
          count: 4,
        },
      },
      'behind@x.com': {
        'plugin:openai-gpt': {
          last_whoami_at: '2026-09-03T12:00:00.000Z',
          manifest_version: 'm1',
          tools_digest: 'd',
          can_write: false,
          count: 1,
        },
      },
    },
    publishes: [
      { object_id: 'req_a', surface: 'plugin:claude', attribution: 'oauth', published_at: '2026-09-04T09:00:00.000Z' },
      { object_id: 'req_b', surface: 'plugin:claude', attribution: 'oauth', published_at: '2026-09-01T09:00:00.000Z' },
    ],
    live: { tools_digest: 'd', manifest_version: 'm2' },
  };

  const rows = installerRows(board);
  assert.equal(rows.length, 2);

  // Newest signal first — the board is read top-down.
  assert.equal(rows[0].email, 'current@x.com');
  assert.equal(rows[0].stale, false);
  assert.equal(rows[0].lastPublishedAt, '2026-09-04T09:00:00.000Z', 'the most recent publish from that surface');

  assert.equal(rows[1].email, 'behind@x.com');
  assert.equal(rows[1].stale, true, 'a re-promote makes an install stale before its next session');
  assert.equal(rows[1].canWrite, false);
  assert.equal(rows[1].lastPublishedAt, null, 'no publish from that surface yet');
});

test('with nothing promoted, no install is called stale — there is nothing to be behind', () => {
  const board: InstallersBoard = {
    signals: {
      'e@x.com': {
        'plugin:claude': {
          last_whoami_at: '2026-09-04T12:00:00.000Z',
          manifest_version: null,
          tools_digest: 'd',
          can_write: true,
          count: 1,
        },
      },
    },
    publishes: [],
    live: { tools_digest: 'd', manifest_version: null },
  };
  assert.equal(installerRows(board)[0].stale, false);
});

// ─── end to end, through the real handlers ───────────────────────────────────

test('a real whoami puts the caller on the board, and the board is admin-gated', async (t) => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });

  const store = (await getGovernanceBlobStore({ headers: HEADERS })) as unknown as OAuthBlobStore;
  await putAccessTokenRecord(store, 'tok-installer', {
    schema_version: 'oauth-access-token.v1',
    client_id: 'cl_claude',
    client_name: 'Claude',
    subject_email: 'owner@example.com',
    subject_id: 'gotrue-owner',
    scope: 'mcp',
    surface: 'plugin:claude',
    site: 'site_drlurie',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  } as never);

  const whoami = await handler({
    httpMethod: 'POST',
    headers: { ...HEADERS, authorization: 'Bearer tok-installer' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
  });
  assert.equal(whoami.statusCode, 200, whoami.body);

  await t.test('an anonymous caller cannot read the board', async () => {
    const refused = await manifestHandler({
      httpMethod: 'GET',
      headers: HEADERS,
      queryStringParameters: { view: 'installers' },
    });
    assert.equal(refused.statusCode, 401);
  });

  await t.test('the owner sees the install that just happened', async () => {
    const response = await manifestHandler(
      { httpMethod: 'GET', headers: HEADERS, queryStringParameters: { view: 'installers' } },
      OWNER
    );
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body) as InstallersBoard & { ok: boolean };
    assert.equal(body.ok, true);
    const signal = body.signals['owner@example.com']?.['plugin:claude'];
    assert.ok(signal, `expected a signal, got ${JSON.stringify(body.signals)}`);
    assert.equal(signal.can_write, true);
    assert.equal(signal.count, 1);
    assert.equal(signal.tools_digest, body.live.tools_digest);
  });

  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
});
