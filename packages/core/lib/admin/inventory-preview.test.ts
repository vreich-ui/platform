import assert from 'node:assert/strict';
import test from 'node:test';

import type { InventoryHit } from './inventory-server-logic.js';
import {
  ADMIN_PREVIEWABLE_PDF_REF_RE,
  canUseInventory,
  getAdminBlobPdfEndpoint,
  inventoryDownloadFilename,
  inventoryPreviewPlan,
  KNOWN_ROLES,
  parseInventoryPreviewJson,
  previewStoreName,
  toInventoryRoles,
} from './inventory-preview.js';

const SHA = 'a'.repeat(64);

const hit = (overrides: Partial<InventoryHit> = {}): InventoryHit => ({
  collection: 'artifacts',
  id: `req_1/${SHA}`,
  label: 'A hit',
  kind: 'image',
  status: 'active',
  updatedAt: null,
  sizeBytes: null,
  previewRef: null,
  refs: [],
  ...overrides,
});

// ─── access ─────────────────────────────────────────────────────────────────

test('toInventoryRoles keeps known roles and drops anything else', () => {
  assert.deepEqual(toInventoryRoles(['owner', 'admin', 'publisher']), ['owner', 'admin', 'publisher']);
  assert.deepEqual(toInventoryRoles(['viewer', 'not-a-role', '']), ['viewer']);
  assert.deepEqual(toInventoryRoles([]), []);
});

test('toInventoryRoles returns roles in the canonical order, not the caller’s', () => {
  assert.deepEqual(toInventoryRoles(['editor', 'owner']), ['owner', 'editor']);
  assert.deepEqual(KNOWN_ROLES.length, 5);
});

test('canUseInventory mirrors the server gate: owner or admin only', () => {
  assert.equal(canUseInventory(['owner', 'admin', 'publisher']), true);
  assert.equal(canUseInventory(['admin']), true);
  assert.equal(canUseInventory(['publisher']), false);
  assert.equal(canUseInventory(['editor', 'viewer']), false);
  assert.equal(canUseInventory([]), false);
});

// ─── endpoints ──────────────────────────────────────────────────────────────

test('getAdminBlobPdfEndpoint accepts only a pdf artifact blob key', () => {
  assert.equal(
    getAdminBlobPdfEndpoint(`pdf/req_1/${SHA}.pdf`),
    `/.netlify/functions/admin-get-blob-pdf?blobKey=${encodeURIComponent(`pdf/req_1/${SHA}.pdf`)}`
  );
  assert.equal(getAdminBlobPdfEndpoint(`  pdf/req_1/${SHA}  `)?.includes('admin-get-blob-pdf'), true);
  assert.equal(getAdminBlobPdfEndpoint(`image/req_1/${SHA}.png`), undefined);
  assert.equal(getAdminBlobPdfEndpoint('pdf/req_1/not-a-sha.pdf'), undefined);
  assert.equal(getAdminBlobPdfEndpoint(''), undefined);
});

test('the PDF blob key pattern matches admin-get-blob-pdf’s own guard', () => {
  assert.equal(ADMIN_PREVIEWABLE_PDF_REF_RE.test(`pdf/req_1/${SHA}`), true);
  assert.equal(ADMIN_PREVIEWABLE_PDF_REF_RE.test(`pdf/req_1/${SHA}.pdf`), true);
  assert.equal(ADMIN_PREVIEWABLE_PDF_REF_RE.test(`pdf/req_1/${SHA}/extra`), false);
});

// ─── preview plan ───────────────────────────────────────────────────────────

test('an image artifact previews as image bytes', () => {
  const plan = inventoryPreviewPlan(hit({ previewRef: `image/req_1/${SHA}.png` }));
  assert.equal(plan.mode, 'image');
  assert.equal(plan.mode === 'image' && plan.endpoint.startsWith('/.netlify/functions/admin-get-blob-image'), true);
  assert.equal(plan.mode === 'image' && plan.cacheKey, `inventory:image:image/req_1/${SHA}.png`);
});

test('a pdf artifact previews as pdf bytes', () => {
  const plan = inventoryPreviewPlan(hit({ kind: 'pdf', previewRef: `pdf/req_1/${SHA}.pdf` }));
  assert.equal(plan.mode, 'pdf');
  assert.equal(plan.mode === 'pdf' && plan.endpoint.includes('admin-get-blob-pdf'), true);
});

test('an artifact with no usable blob key falls back to json, never to a broken image', () => {
  assert.deepEqual(inventoryPreviewPlan(hit({ previewRef: null })), { mode: 'json' });
  assert.deepEqual(inventoryPreviewPlan(hit({ previewRef: '   ' })), { mode: 'json' });
  assert.deepEqual(inventoryPreviewPlan(hit({ previewRef: 'artifacts/whatever.bin' })), { mode: 'json' });
});

test('objects and store blobs are always json previews, whatever their previewRef looks like', () => {
  assert.deepEqual(inventoryPreviewPlan(hit({ collection: 'objects', previewRef: `image/req_1/${SHA}.png` })), {
    mode: 'json',
  });
  assert.deepEqual(inventoryPreviewPlan(hit({ collection: 'stores', previewRef: 'workflows/run_1' })), {
    mode: 'json',
  });
});

test('inventoryDownloadFilename uses the blob key’s last segment, falling back to the hit id', () => {
  assert.equal(inventoryDownloadFilename(hit({ previewRef: `pdf/req_1/${SHA}.pdf` })), `${SHA}.pdf`);
  assert.equal(inventoryDownloadFilename(hit({ previewRef: null, id: `req_1/${SHA}` })), SHA);
});

// ─── preview payloads ───────────────────────────────────────────────────────

test('previewStoreName reports a store hit’s store name, which lives on kind', () => {
  assert.equal(previewStoreName(hit({ collection: 'stores', kind: 'workflows' })), 'workflows');
  assert.equal(previewStoreName(hit({ collection: 'objects', kind: 'content_item' })), 'objects');
  assert.equal(previewStoreName(hit({ collection: 'artifacts', kind: 'image' })), 'artifacts');
});

test('parseInventoryPreviewJson returns the object for a complete json payload', () => {
  assert.deepEqual(parseInventoryPreviewJson('json', '{"status":"ready","nodes":2}'), { status: 'ready', nodes: 2 });
});

test('parseInventoryPreviewJson refuses anything it cannot prove is an object', () => {
  // A truncated 32 KB preview is no longer valid JSON — no summary is shown.
  assert.equal(parseInventoryPreviewJson('json', '{"status":"rea'), null);
  assert.equal(parseInventoryPreviewJson('text', 'plain text blob'), null);
  assert.equal(parseInventoryPreviewJson('json', '[1,2,3]'), null);
  assert.equal(parseInventoryPreviewJson('json', '"scalar"'), null);
  assert.equal(parseInventoryPreviewJson('json', 'null'), null);
  assert.equal(parseInventoryPreviewJson('json', undefined), null);
  assert.equal(parseInventoryPreviewJson(undefined, '{"a":1}'), null);
});
