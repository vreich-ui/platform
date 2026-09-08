import assert from 'node:assert/strict';
import test from 'node:test';

import type { InventoryHit } from './inventory-server-logic.js';
import {
  ADMIN_PREVIEWABLE_PDF_REF_RE,
  canUseInventory,
  getAdminBlobPdfEndpoint,
  inventoryDownloadFilename,
  inventoryPreviewPlan,
  inventoryTypeVisual,
  KNOWN_ROLES,
  objectTypeVisual,
  OBJECT_TYPE_ICONS,
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
  thumbnailRef: null,
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

test('an object’s own previewRef is never treated as image bytes — it is the object id', () => {
  // This is what made every Objects row a text chip: `normalizeObjectHit`
  // sets previewRef to the hit id. The image now comes from thumbnailRef.
  assert.deepEqual(inventoryPreviewPlan(hit({ collection: 'objects', previewRef: `image/req_1/${SHA}.png` })), {
    mode: 'json',
  });
  assert.deepEqual(inventoryPreviewPlan(hit({ collection: 'stores', previewRef: 'workflows/run_1' })), {
    mode: 'json',
  });
});

test('an object with a joined thumbnail previews through the SAME image endpoint and cache key as the artifact row', () => {
  const blobKey = `image/req_1/${SHA}.png`;
  const objectPlan = inventoryPreviewPlan(
    hit({ collection: 'objects', kind: 'content_item', previewRef: 'content_item/req_1', thumbnailRef: blobKey })
  );
  const artifactPlan = inventoryPreviewPlan(hit({ previewRef: blobKey }));

  assert.deepEqual(objectPlan, artifactPlan);
  assert.equal(objectPlan.mode === 'image' && objectPlan.cacheKey, `inventory:image:${blobKey}`);
});

test('a thumbnailRef the image endpoint would refuse degrades to the type visual, not to a broken image', () => {
  assert.deepEqual(
    inventoryPreviewPlan(hit({ collection: 'objects', thumbnailRef: 'image/../secrets.png' })),
    { mode: 'json' }
  );
  assert.deepEqual(inventoryPreviewPlan(hit({ collection: 'objects', thumbnailRef: '  ' })), { mode: 'json' });
});

test('thumbnailRef is the proof, not the collection — a store row simply never carries one', () => {
  // The plan asks "can this row prove image bytes?", so any future collection
  // the server joins imagery for works without touching this function.
  // `normalizeStoreHit` leaves store rows at null, which is why they render
  // the type visual in practice.
  assert.equal(
    inventoryPreviewPlan(hit({ collection: 'stores', kind: 'workflows', thumbnailRef: `image/req_1/${SHA}.png` })).mode,
    'image'
  );
  assert.equal(inventoryPreviewPlan(hit({ collection: 'stores', kind: 'workflows' })).mode, 'json');
});

// ─── type visuals ───────────────────────────────────────────────────────────

test('every governed object type has its own icon and its human label', () => {
  assert.deepEqual(objectTypeVisual('content_item'), { iconId: 'note', label: 'Article' });
  assert.deepEqual(objectTypeVisual('page'), { iconId: 'layout-list', label: 'Page' });
  assert.deepEqual(objectTypeVisual('navigation'), { iconId: 'menu', label: 'Navigation' });
  assert.deepEqual(objectTypeVisual('editorial_voice'), { iconId: 'mic', label: 'Editorial voice' });
  assert.equal(Object.keys(OBJECT_TYPE_ICONS).length, 13, 'all thirteen object types are mapped');
});

test('an unknown object type still gets a visual and a readable name, never another type’s icon', () => {
  assert.deepEqual(objectTypeVisual('some_future_type'), { iconId: 'info', label: 'Some future type' });
  assert.deepEqual(objectTypeVisual(''), { iconId: 'info', label: 'Item' });
});

test('stores and artifacts get a type visual too, so the preview column is never empty', () => {
  assert.deepEqual(inventoryTypeVisual(hit({ collection: 'stores', kind: 'agent-chats' })), {
    iconId: 'settings',
    label: 'Store blob',
  });
  assert.deepEqual(inventoryTypeVisual(hit({ collection: 'artifacts', kind: 'image' })), {
    iconId: 'note',
    label: 'Image',
  });
  assert.deepEqual(inventoryTypeVisual(hit({ collection: 'objects', kind: 'theme' })), {
    iconId: 'palette',
    label: 'Theme',
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
