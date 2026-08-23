/**
 * W19 T19.2 — the HTTP-layer contract and the two rules that are easy to
 * regress by accident.
 *
 * The full handler needs a real Netlify Identity-authenticated event to
 * exercise end to end (no test-injection seam exists for
 * `getAdminStateFromEvent` — the admin-governance.test.ts precedent). Three
 * levels of proof instead: the request CONTRACT, the archive GATE as a pure
 * function, and a source-level assertion that `list` cannot degrade to the
 * O(N) scan this wave exists to remove.
 */
import '../../../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUEST_PAGE_SIZE, canArchive, requestSchema } from './admin-requests.js';

/** The compiled test runs from `.tmp/ci-test`, so walk up to the repo root (the admin-governance.test.ts precedent). */
const repoRoot = (): string => {
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (root !== path.dirname(root)) {
    if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/admin'))) break;
    root = path.dirname(root);
  }
  return root;
};
const source = readFileSync(path.join(repoRoot(), 'packages/core/server/functions/admin-requests.ts'), 'utf8');

describe('admin-requests requestSchema', () => {
  it('accepts a bare list and every filter it documents', () => {
    assert.equal(requestSchema.safeParse({ action: 'list' }).success, true);
    assert.equal(
      requestSchema.safeParse({
        action: 'list',
        status: ['needs_you', 'stalled'],
        kind: ['article'],
        mine: true,
        archived: false,
        q: 'retinol',
        cursor: '100',
        limit: 25,
      }).success,
      true
    );
  });

  it('rejects an unknown status rather than silently ignoring it', () => {
    assert.equal(requestSchema.safeParse({ action: 'list', status: ['in_progress'] }).success, false);
  });

  it('caps the page size at the server bound', () => {
    assert.equal(requestSchema.safeParse({ action: 'list', limit: REQUEST_PAGE_SIZE }).success, true);
    assert.equal(requestSchema.safeParse({ action: 'list', limit: REQUEST_PAGE_SIZE + 1 }).success, false);
    assert.equal(requestSchema.safeParse({ action: 'list', limit: 0 }).success, false);
  });

  it('requires a request_id on every per-request action', () => {
    for (const action of ['get', 'archive', 'unarchive', 'cancel', 'mute', 'unmute']) {
      assert.equal(requestSchema.safeParse({ action }).success, false, `${action} without an id`);
      assert.equal(
        requestSchema.safeParse({ action, request_id: 'req_agent_x_20260822_01' }).success,
        true,
        `${action} with an id`
      );
    }
  });

  it('rejects an unknown action', () => {
    assert.equal(requestSchema.safeParse({ action: 'delete', request_id: 'x' }).success, false);
  });
});

describe('the archive gate (plan §8)', () => {
  it('admits Owner and publisher, and nobody else', () => {
    assert.equal(canArchive(['owner']), true);
    assert.equal(canArchive(['publisher']), true);
    assert.equal(canArchive(['admin']), false);
    assert.equal(canArchive(['editor']), false);
    assert.equal(canArchive([]), false);
  });
});

describe('the two rules this endpoint must not regress', () => {
  it('never scans: `list` reads the index and the O(N) walk is not even imported (plan F7)', () => {
    assert.ok(!source.includes('listRequestDocs'), 'admin-requests must not import the O(N) doc walk');
    assert.ok(source.includes('loadIndex('), 'list must read the index doc');
    assert.ok(source.includes('rebuilt: true'), 'a rebuild must be reported, never silent');
  });

  it('reads team-wide: the creator-scoped chat rule is deliberately not applied (plan §8)', () => {
    assert.ok(!source.includes('visibleChatDocs'), 'requests are team-wide readable — see the module header');
    assert.ok(
      /TEAM-WIDE/.test(source),
      'the departure from chat-visibility must stay commented, so nobody "fixes" it back'
    );
  });
});
