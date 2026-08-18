/**
 * W18 review regression (2026-08-18) — **every membership listing must survive
 * a PAGINATED blob store.**
 *
 * `@netlify/blobs@10` types `list()` with two overloads:
 *
 *   list(options & { paginate: true }):  AsyncIterable<ListResult>   ← NOT a Promise
 *   list(options & { paginate?: false }): Promise<ListResult>
 *
 * Every membership helper asks for `paginate: true` and used to read `.blobs`
 * off the awaited value. `await <AsyncIterable>` yields the iterable itself, so
 * `.blobs` was `undefined`, `?? []` swallowed it, and in production the members
 * list, the invitations tab, the audit drawer, the invite-token preview, the
 * expiry sweep, the OAuth-revocation and lock-release offboarding effects and
 * the `min_owners` guard ALL silently saw an empty store — while every unit
 * test passed, because every test mock returned `{ blobs }` as a Promise and
 * ignored `paginate`.
 *
 * This file's store is the ONLY one in the suite that honours `paginate: true`
 * the way the real client does — multi-page, async-iterable. It exists so the
 * defect cannot come back unnoticed. The companion source guard below fails if
 * any new `paginate: true` call site skips `collectBlobListItems`.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createInvitation,
  expireAll,
  listInvitations,
  listUnmanagedIdentities,
  previewInvitationByToken,
} from '../../packages/core/server/lib/membership/invitations.js';
import { countActiveOwners, listMembers } from '../../packages/core/server/lib/membership/read.js';
import {
  appendAudit,
  listAuditForEmail,
  newMember,
  saveMember,
} from '../../packages/core/server/lib/membership/write.js';
import { personIdForEmail, type MembershipStore } from '../../packages/core/server/lib/membership/store.js';
import { listUserRecords, type UsersBlobStore } from '../../packages/core/server/lib/users-store.js';

const AT = '2026-08-17T12:00:00.000Z';
const WEEK_LATER = '2026-08-25T12:00:01.000Z';
const ACTOR = { kind: 'human' as const, id: 'boss-id', email: 'boss@x.com' };
const BOSS = { person_id: personIdForEmail('boss@x.com'), email: 'boss@x.com' };

/**
 * A store that behaves like the REAL Netlify Blobs client:
 *   - `paginate: true`  → a plain AsyncIterable of pages (no `.then`, no `.blobs`)
 *   - otherwise         → a Promise of one page
 * Pages are deliberately small so multi-page collection is exercised.
 */
const PAGE_SIZE = 2;
const paginatedMemStore = (): UsersBlobStore & MembershipStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      map.set(key, JSON.stringify(value));
    },
    async delete(key: string) {
      map.delete(key);
    },
    list(options: { prefix: string; paginate?: boolean }) {
      const keys = [...map.keys()].filter((key) => key.startsWith(options.prefix));
      const pages: Array<{ blobs: { key: string }[] }> = [];
      for (let i = 0; i < keys.length; i += PAGE_SIZE) {
        pages.push({ blobs: keys.slice(i, i + PAGE_SIZE).map((key) => ({ key })) });
      }
      if (!options.paginate) return Promise.resolve(pages[0] ?? { blobs: [] });
      // NOTE: an object with ONLY Symbol.asyncIterator — no `.then`, no
      // `.blobs`. Awaiting it hands back this same object.
      return {
        async *[Symbol.asyncIterator]() {
          for (const page of pages.length ? pages : [{ blobs: [] }]) yield page;
        },
      };
    },
  } as UsersBlobStore & MembershipStore & { map: Map<string, string> };
};

const seedMember = (email: string, role: 'owner' | 'editor', status: 'active' | 'invited') =>
  newMember({
    email,
    display_name: email,
    role,
    status,
    source: 'invitation',
    granted_by: { kind: 'human', email: BOSS.email },
    invited_by: BOSS.email,
    at: AT,
  });

test('listMembers reads every page of a paginated store', async () => {
  const store = paginatedMemStore();
  // > PAGE_SIZE members, so a single-page read would under-report even if the
  // AsyncIterable were mistaken for a page.
  const emails = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'];
  for (const email of emails) await saveMember(store, seedMember(email, 'editor', 'active'));

  const members = await listMembers(store);
  assert.deepEqual(
    members.map((m) => m.person.email),
    emails
  );
  assert.equal((await listUserRecords(store)).length, emails.length);
});

test('countActiveOwners sees stored owners (the min_owners guard depends on it)', async () => {
  const store = paginatedMemStore();
  await saveMember(store, seedMember('owner1@x.com', 'owner', 'active'));
  await saveMember(store, seedMember('owner2@x.com', 'owner', 'active'));
  await saveMember(store, seedMember('ed@x.com', 'editor', 'active'));

  assert.equal(await countActiveOwners(store), 2);
  assert.equal(await countActiveOwners(store, personIdForEmail('owner1@x.com')), 1);
});

test('listInvitations, previewInvitationByToken and expireAll work against a paginated store', async () => {
  const store = paginatedMemStore();
  const created = await Promise.all(
    ['one@x.com', 'two@x.com', 'three@x.com'].map((email) =>
      createInvitation(store, {
        email,
        role: 'editor',
        invitedBy: BOSS,
        actor: ACTOR,
        at: AT,
        skipGoTrue: true,
      })
    )
  );

  const pending = await listInvitations(store, { status: 'pending', now: AT });
  assert.equal(pending.length, 3, 'the Invitations tab must see every pending invite');

  const preview = await previewInvitationByToken(store, created[0].accept_token, AT);
  assert.equal(preview?.email, 'one@x.com');

  const expired = await expireAll(store, WEEK_LATER);
  assert.equal(expired.length, 3);
  assert.equal((await listInvitations(store, { status: 'pending', now: WEEK_LATER })).length, 0);
});

test('listAuditForEmail reads the whole audit stream', async () => {
  const store = paginatedMemStore();
  const email = 'audited@x.com';
  for (const action of ['invitation.create', 'invitation.accept', 'membership.role_change'] as const) {
    await appendAudit(store, {
      at: AT,
      actor: { kind: 'human', email: BOSS.email },
      action,
      target: { person_id: personIdForEmail(email), email },
      via: 'admin_ui',
    });
  }
  const events = await listAuditForEmail(store, email);
  assert.equal(events.length, 3, 'the audit drawer must not come back empty');
});

test('listUnmanagedIdentities excludes people who ARE members', async () => {
  const store = paginatedMemStore();
  await saveMember(store, seedMember('member@x.com', 'editor', 'active'));
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      users: [
        { id: 'u1', email: 'member@x.com', confirmed_at: AT },
        { id: 'u2', email: 'stranger@x.com' },
      ],
    }),
  });

  const result = await listUnmanagedIdentities({
    store,
    identity: { url: 'https://site/.netlify/identity', token: 'admin-token' },
    fetchImpl,
  });
  assert.deepEqual(
    result.identities.map((i) => i.email),
    ['stranger@x.com'],
    'a known member must never be offered as an unmanaged identity to delete'
  );
});

// ── source guard ────────────────────────────────────────────────────────────

const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    try {
      if (statSync(join(dir, 'packages', 'core', 'server', 'lib', 'blob-list.ts')).isFile()) return dir;
    } catch {
      // keep walking
    }
    dir = resolve(dir, '..');
  }
  throw new Error('repo root not found from the compiled test location');
};

const walkTs = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

test('every `paginate: true` call site goes through collectBlobListItems', () => {
  const root = repoRoot();
  const offenders: string[] = [];
  for (const file of walkTs(join(root, 'packages', 'core', 'server'))) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('paginate: true')) continue;
    if (source.includes('collectBlobListItems')) continue;
    offenders.push(relative(root, file));
  }
  assert.deepEqual(
    offenders,
    [],
    `these files ask a blob store to paginate but never collect the pages — ` +
      `\`(await store.list({ paginate: true })).blobs\` is always undefined:\n  ${offenders.join('\n  ')}`
  );
});
