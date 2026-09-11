/**
 * T-ASSET-IDENTITY Part 2 — `search_artifacts` distinguishes forbidden,
 * unknown-tag, empty-tenant-wide-tags, empty-match, and ok as four distinct
 * SUCCESS outcomes plus the pre-existing forbidden error, instead of
 * collapsing "you may not see this", "this tag was never used, but the
 * tenant tags other things", "this tenant has never tagged anything", and
 * "this tag exists but nothing currently matches" into one identical
 * `{ artifacts: [] }` shape.
 *
 * Additive-only: `artifacts` / `limit` / `cursor` / `nextCursor` are
 * unchanged in every case, so a caller reading only those fields is
 * unaffected — only the new `outcome` (and, on a non-'ok' outcome, `remedy`)
 * fields are new.
 */
import '../../../../sites/drlurie/config/policy-bindings.js';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalBlobStore, setLocalBlobsRootForTesting } from './local-blobs.js';
import { writeArtifactReferenceIndexes, type ArtifactIndexStore } from './artifact-index.js';
import type { ArtifactReference } from './artifacts.js';
import { searchArtifacts } from './mcp-artifact-admin.js';

const PLATFORM_VARS = [
  'NETLIFY_SITE_ID',
  'SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_BLOBS_API_URL',
];
const savedEnv: Record<string, string | undefined> = {};

// The server-verified event flag every real /mcp call carries after the gate
// check (mcp.ts) — this file is testing searchArtifacts's OUTCOME logic, not
// the admin gate itself (that is Part 1's file), so bypass it the same way
// the server does once identity is already established.
const gatedEvent = { httpMethod: 'POST', headers: {}, mcpGateAuthenticated: true } as never;

const REQUEST_ID = 'req_capture_search_outcome_20260910_01';

const reference = (overrides: Partial<ArtifactReference> = {}): ArtifactReference => ({
  blobKey: `image/${REQUEST_ID}/${'a'.repeat(64)}.jpg`,
  sizeBytes: 1024,
  sha256: 'a'.repeat(64),
  contentType: 'image/jpeg',
  createdAtISO: '2026-01-01T00:00:00.000Z',
  artifactKind: 'image',
  ...overrides,
});

describe('mcp-artifact-admin: search_artifacts distinguishes forbidden / unknown-tag / empty-tenant / empty / ok (T-ASSET-IDENTITY Part 2)', () => {
  let root: string;

  before(async () => {
    for (const name of PLATFORM_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  after(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'search-outcome-'));
    setLocalBlobsRootForTesting(root);
  });

  after(async () => {
    setLocalBlobsRootForTesting(undefined);
  });

  it('forbidden stays a distinct error, not an empty success', async () => {
    const unauthenticated = { httpMethod: 'POST', headers: {} } as never;
    const result = await searchArtifacts(unauthenticated, {});
    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.strictEqual((result.structuredContent as { error_code?: string }).error_code, 'admin_required');
    assert.strictEqual((result.structuredContent as { outcome?: string }).outcome, undefined);
  });

  it('outcome "ok": a real tag with a live match', async () => {
    const store = createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore;
    await writeArtifactReferenceIndexes(store, REQUEST_ID, reference({ tags: ['hero'] }));

    const result = await searchArtifacts(gatedEvent, { tag: 'hero' });
    const content = result.structuredContent as { outcome: string; artifacts: unknown[] };
    assert.strictEqual(content.outcome, 'ok');
    assert.strictEqual(content.artifacts.length, 1);
  });

  it('outcome "empty": the tag is real and in use, but nothing currently matches (createdAfter excludes it)', async () => {
    const store = createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore;
    await writeArtifactReferenceIndexes(
      store,
      REQUEST_ID,
      reference({ tags: ['hero'], createdAtISO: '2026-01-01T00:00:00.000Z' })
    );

    const result = await searchArtifacts(gatedEvent, { tag: 'hero', createdAfter: '2027-01-01T00:00:00.000Z' });
    const content = result.structuredContent as { outcome: string; artifacts: unknown[] };
    assert.strictEqual(content.outcome, 'empty');
    assert.strictEqual(content.artifacts.length, 0);
  });

  it('outcome "unknown_tag": this exact tag was never used, but the tenant DOES tag other artifacts (likely typo)', async () => {
    const store = createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore;
    await writeArtifactReferenceIndexes(store, REQUEST_ID, reference({ tags: ['hero'] }));

    const result = await searchArtifacts(gatedEvent, { tag: 'hreo' });
    const content = result.structuredContent as { outcome: string; artifacts: unknown[]; remedy: string };
    assert.strictEqual(content.outcome, 'unknown_tag');
    assert.strictEqual(content.artifacts.length, 0);
    assert.match(content.remedy, /spelling|without a tag filter/i);
  });

  it('outcome "no_tags_recorded_for_tenant": zero artifacts in this tenant have EVER been tagged', async () => {
    // A fresh, untouched local store root: no reference has ever been written
    // with a tag, so `by-tag/` is empty tenant-wide — distinct from a typo.
    const result = await searchArtifacts(gatedEvent, { tag: 'anything' });
    const content = result.structuredContent as { outcome: string; artifacts: unknown[]; remedy: string };
    assert.strictEqual(content.outcome, 'no_tags_recorded_for_tenant');
    assert.strictEqual(content.artifacts.length, 0);
    assert.match(content.remedy, /has ever been tagged/i);
  });

  it('a tagless search still reports outcome, additive to the existing artifacts/limit/cursor/nextCursor shape', async () => {
    const store = createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore;
    await writeArtifactReferenceIndexes(store, REQUEST_ID, reference());

    const result = await searchArtifacts(gatedEvent, {});
    const content = result.structuredContent as {
      outcome: string;
      artifacts: unknown[];
      limit: number;
      cursor: string;
      nextCursor: string | null;
    };
    assert.strictEqual(content.outcome, 'ok');
    assert.strictEqual(content.artifacts.length, 1);
    assert.strictEqual(typeof content.limit, 'number');
    assert.strictEqual(typeof content.cursor, 'string');
    assert.ok(content.nextCursor === null || typeof content.nextCursor === 'string');
  });
});
