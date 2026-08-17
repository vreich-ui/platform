import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { navigationBodySchema } from '../../schema/bodies/navigation-v1.js';
import { pageBodySchema } from '../../schema/bodies/page-v1.js';
import { sectionInstanceSchema } from '../../schema/bodies/section-v1.js';
import { REGISTERED_SECTION_TYPES } from '../../lib/registry/components/registered-types.js';
import { getPageTypeDefinition } from '../../lib/registry/page-types.js';
import { checkStructuralInvariants } from '../../server/lib/object-validate.js';
import {
  bindMappingAssets,
  bindSectionAssets,
  CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS,
  FIRST_PARTY_ASSET_PATH_RE,
  firstPartyAssetPath,
  mapSnapshot,
} from './map.mjs';

const sha256Of = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * A stand-in for what emission's `create_artifact_from_url` returns: the
 * Major-Key reference of a materialized first-party artifact. The binder derives
 * the served path itself, so this is the ONLY input shape it accepts.
 */
const materializedArtifactRef = (manifestRef: string) =>
  `image/req_capture_fixture_20260817_01/${sha256Of(manifestRef)}.jpg`;

async function readRepoJson(relativePath: string) {
  let root = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await readFile(path.join(root, 'astro.config.ts'));
      return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
    } catch {
      root = path.dirname(root);
    }
  }
  throw new Error('Could not locate source fixture root.');
}

async function readFixture(name: string) {
  return readRepoJson(path.join('packages/core/cli/capture/fixtures', name));
}

test('redacted snapshot maps byte-for-byte to the checked-in golden artifact', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const golden = await readFixture('zilberman.mapping.v1.redacted.json');
  assert.deepEqual(mapSnapshot(snapshot), golden);
});

test('every emitted page, section, and navigation candidate uses the live schemas', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const unbound = mapSnapshot(snapshot);

  // T12.14: a section with a pending asset plan is deliberately INCOMPLETE until
  // emission binds a materialized artifact into it — proving it can never be
  // created un-bound is the point of the two-phase design, so assert the
  // incompleteness rather than schema-validating a half-built body.
  const pending = unbound.pages.flatMap((page) =>
    page.candidates.filter((candidate: { assetPlan?: unknown }) => candidate.assetPlan)
  );
  assert.ok(pending.length > 0, 'the fixture must exercise the asset-binding path');
  for (const candidate of pending) {
    assert.equal(candidate.assetBindingStatus, 'pending');
    assert.equal(
      sectionInstanceSchema.safeParse(candidate.section).success,
      false,
      `${candidate.candidateId} must not be schema-complete before its asset field is bound`
    );
    // The plan is the ONLY channel to emission and it carries no source URL.
    assert.equal(JSON.stringify(candidate.assetPlan).includes('http'), false);
  }

  const { mapping, bound, quarantined } = bindMappingAssets(unbound, materializedArtifactRef);
  assert.equal(quarantined.length, 0);
  assert.equal(bound.length, pending.length);
  for (const page of mapping.pages) {
    assert.equal(pageBodySchema.safeParse(page.pageBody).success, true, page.sourceUrl);
    for (const candidate of page.candidates) {
      assert.equal(REGISTERED_SECTION_TYPES.includes(candidate.sectionType as never), true, candidate.sectionType);
      assert.deepEqual(candidate.data, candidate.section.data);
      const parsed = sectionInstanceSchema.safeParse(candidate.section);
      assert.equal(parsed.success, true, parsed.success ? candidate.candidateId : JSON.stringify(parsed.error.issues));
    }
  }
  for (const page of unbound.pages) {
    // The unbound mapping keeps section ORDER intact, so binding never reorders
    // a page: the ids that survive binding do so in place.
    const boundIds = mapping.pages
      .find((entry: { pageRef: string }) => entry.pageRef === page.pageRef)!
      .pageBody.sections.map((section: { id: string }) => section.id);
    assert.deepEqual(
      boundIds,
      page.pageBody.sections.map((section: { id: string }) => section.id)
    );
  }
  for (const candidate of mapping.navigationCandidates) {
    const parsed = navigationBodySchema.safeParse(candidate.body);
    assert.equal(parsed.success, true, parsed.success ? candidate.candidateId : JSON.stringify(parsed.error.issues));
    assert.ok(candidate.body.groups.every((group: { items: unknown[] }) => group.items.length > 0));
    assert.ok((candidate.body.actions?.length ?? 0) <= 3);
  }
});

test('every emitted page survives the live PageType structural contract unchanged', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const mapping = mapSnapshot(snapshot);
  for (const page of mapping.pages) {
    const lookup = getPageTypeDefinition(page.pageBody.pageType);
    assert.equal(lookup.ok, true, page.pageBody.pageType);
    if (!lookup.ok) continue;
    const captureAllowed = CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS[page.pageBody.pageType as 'home' | 'standard'];
    assert.deepEqual(
      captureAllowed === 'any' ? captureAllowed : [...captureAllowed],
      lookup.definition.allowedSections,
      `${page.pageBody.pageType} capture guard drifted from the registry`
    );
    const criteria = checkStructuralInvariants(
      'page',
      `candidate_${page.pageRef}`,
      page.pageBody,
      { pageType: lookup.definition },
      false
    );
    assert.equal(
      criteria.some((criterion) => criterion.id === 'structure_allowed' && criterion.status === 'missing'),
      false,
      JSON.stringify(criteria)
    );
  }
});

test('every source block is accounted exactly once and every copy field is tagged extracted', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const mapping = mapSnapshot(snapshot);
  assert.equal(mapping.summary.sourceBlocks, mapping.summary.accountedBlocks);
  for (const page of mapping.pages) {
    assert.equal(
      new Set(page.blockAccounting.map((item: { blockRef: string }) => item.blockRef)).size,
      page.blockAccounting.length
    );
    for (const candidate of page.candidates) {
      assert.ok(candidate.provenance.textFields.length > 0);
      assert.ok(candidate.provenance.textFields.every((field: { source: string }) => field.source === 'extracted'));
      assert.ok(
        candidate.assetBindings.every(
          (asset: { sourceUrl: string }) => !JSON.stringify(candidate.section).includes(asset.sourceUrl)
        )
      );
    }
  }
});

test('quarantined input and unsafe thresholds fail closed', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  assert.throws(
    () => mapSnapshot({ ...snapshot, diagnostics: { ...snapshot.diagnostics, quarantined: [{}] } }),
    /quarantined/
  );
  assert.throws(() => mapSnapshot(snapshot, { threshold: -0.1 }), /0\.\.1/);
});

test('assistance can choose a registered builder but cannot inject arbitrary section data', () => {
  const snapshot = {
    schemaVersion: 'snapshot.v1',
    capture: {
      capturedAt: '2026-08-13T00:00:00.000Z',
      targetUrl: 'https://example.com/',
      origin: 'https://example.com',
      redacted: false,
    },
    diagnostics: { quarantined: [] },
    pages: [
      {
        pageId: 'page_example',
        url: 'https://example.com/example',
        path: '/example',
        title: 'Example',
        metaDescription: null,
        outline: [{ tag: 'h1', level: 1, text: 'Example' }],
        navigation: { primary: [], footer: [] },
        assets: [],
        blocks: [
          {
            id: 'page_example_block_001',
            ordinal: 0,
            tag: 'section',
            text: { value: 'ExampleA body with enough deterministic content.' },
            links: [],
            assetUrls: [],
            boundingBoxes: { desktop: { width: 100, height: 100 } },
            screenshots: [{ captured: true, path: 'example.png' }],
          },
        ],
      },
    ],
  };
  const mapping = mapSnapshot(snapshot, {
    assistance: {
      suggestions: [
        { blockRef: 'page_example_block_001', sectionType: 'prose', data: { arbitrary: 'must be ignored' } },
      ],
    },
  });
  assert.equal(mapping.pages[0].candidates[0].sectionType, 'prose');
  assert.deepEqual(mapping.pages[0].candidates[0].section.data, {
    body: '<p>ExampleA body with enough deterministic content.</p>',
  });
});

// ─── T12.14 acceptance ───────────────────────────────────────────────────────

const ASSET_MATERIALIZATION_CAPABILITIES = [
  'first-party artifact materialization plus a schema-safe asset field; source URLs cannot be emitted as hotlinks',
  'materialized first-party asset references and item-level text association',
];

test('the recorded asset-capability gaps close: no gap in the replayed ledger still asks for asset materialization', async () => {
  // The COMMITTED 2026-08-13 live run recorded 14 gaps; 8 of them named one of
  // the two asset-materialization capabilities below. Those two capabilities are
  // what T12.14 built, so no gap in the replayed ledger may still ask for them.
  const live = await readRepoJson(
    'packages/core/cli/capture/reports/zilberman.2026-08-13.fidelity-report.v1.json'
  );
  const liveAssetGaps = live.gapReport.byCapability.filter((entry: { missingCapability: string }) =>
    ASSET_MATERIALIZATION_CAPABILITIES.includes(entry.missingCapability)
  );
  assert.equal(
    liveAssetGaps.reduce((total: number, entry: { count: number }) => total + entry.count, 0),
    8,
    'the committed live report must still record the 8 asset-capability gaps this task answers'
  );

  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const mapping = mapSnapshot(snapshot);
  const gaps = mapping.pages.flatMap((page: { gaps: Array<{ missingCapability: string }> }) => page.gaps);
  for (const capability of ASSET_MATERIALIZATION_CAPABILITIES) {
    assert.equal(
      gaps.some((gap: { missingCapability: string }) => gap.missingCapability === capability),
      false,
      `a replayed gap still asks for: ${capability}`
    );
  }

  // Per-block disposition of the 8 recorded asset gaps. Each block is either
  // MAPPED with its image evidence bound, or still a gap for a reason that is NOT
  // asset materialization (the home PageType placement backlog, or a section
  // palette that has no field for a lone image beside body copy).
  const liveAssetBlockRefs = live.gapReport.entries
    .filter((entry: { missingCapability: string }) =>
      ASSET_MATERIALIZATION_CAPABILITIES.includes(entry.missingCapability)
    )
    .map((entry: { blockRef: string }) => entry.blockRef);
  assert.equal(liveAssetBlockRefs.length, 8);
  const accounting = new Map<string, { status: string; candidateId?: string; gapId?: string }>(
    mapping.pages.flatMap((page: { blockAccounting: Array<{ blockRef: string }> }) =>
      page.blockAccounting.map((entry: { blockRef: string }) => [entry.blockRef, entry])
    )
  );
  const candidates = new Map<string, { sectionType: string; assetPlan?: { target: string } }>(
    mapping.pages.flatMap((page: { candidates: Array<{ candidateId: string }> }) =>
      page.candidates.map((candidate: { candidateId: string }) => [candidate.candidateId, candidate])
    )
  );
  const gapsById = new Map<string, { why: string; missingCapability: string }>(
    mapping.pages.flatMap((page: { gaps: Array<{ gapId: string }> }) =>
      page.gaps.map((gap: { gapId: string }) => [gap.gapId, gap])
    )
  );
  const boundWithMedia: string[] = [];
  for (const blockRef of liveAssetBlockRefs) {
    const entry = accounting.get(blockRef);
    assert.ok(entry, `${blockRef} must still be accounted`);
    if (entry!.status === 'gap') {
      const gap = gapsById.get(entry!.gapId!)!;
      assert.ok(
        ['section_not_allowed_for_page_type', 'insufficient_structure'].includes(gap.why),
        `${blockRef} still declines for an asset reason: ${gap.why}`
      );
      continue;
    }
    const candidate = candidates.get(entry!.candidateId!)!;
    if (candidate.assetPlan) boundWithMedia.push(blockRef);
    else
      assert.equal(
        gapsById.get(entry!.gapId!)!.why,
        'section_type_has_no_asset_field',
        `${blockRef} is mapped without an asset plan and without saying why`
      );
  }
  assert.ok(boundWithMedia.length >= 4, `expected at least 4 of the 8 to bind media, got ${boundWithMedia.length}`);
});

test('mapped coverage on the committed fixture is the recorded 10/19 = 52.63%', async () => {
  // The before/after recorded in the T12.14 brief: 3/19 = 15.79% before this
  // task, 10/19 = 52.63% after. The 90% bar is untouched and still unmet.
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const mapping = mapSnapshot(snapshot);
  const relevant = mapping.pages.flatMap((page: { blockAccounting: Array<{ status: string }> }) =>
    page.blockAccounting.filter(
      (entry: { status: string }) => !['duplicate', 'merged', 'ignored_noncontent'].includes(entry.status)
    )
  );
  const mapped = relevant.filter((entry: { status: string }) => ['mapped', 'mapped_with_gap'].includes(entry.status));
  assert.equal(relevant.length, 19);
  assert.equal(mapped.length, 10);
  assert.equal(Number((mapped.length / relevant.length).toFixed(4)), 0.5263);
  assert.equal(mapping.summary.pendingAssetSections, 7);
});

test('alt text is carried from the source block’s own item-level text association', async () => {
  const snapshot = {
    schemaVersion: 'snapshot.v1',
    capture: {
      capturedAt: '2026-08-17T00:00:00.000Z',
      targetUrl: 'https://example.com/',
      origin: 'https://example.com',
      redacted: false,
      policy: { rights: { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' } },
    },
    diagnostics: { quarantined: [] },
    pages: [
      {
        pageId: 'page_gallery',
        url: 'https://example.com/gallery',
        path: '/gallery',
        title: 'Gallery',
        metaDescription: null,
        outline: [],
        navigation: { primary: [], footer: [] },
        assets: [
          { url: 'https://cdn.example.com/one.jpg', kind: 'image', alt: 'A rehearsal in Kyiv', downloaded: false },
          { url: 'https://cdn.example.com/two.jpg', kind: 'image', alt: 'Opening night curtain', downloaded: false },
          { url: 'https://cdn.example.com/three.jpg', kind: 'image', alt: null, downloaded: false },
        ],
        blocks: [
          {
            id: 'page_gallery_block_001',
            ordinal: 0,
            tag: 'section',
            text: { value: 'Season gallery' },
            links: [],
            assetUrls: [
              'https://cdn.example.com/one.jpg',
              'https://cdn.example.com/two.jpg',
              'https://cdn.example.com/three.jpg',
            ],
            boundingBoxes: { desktop: { width: 100, height: 100 } },
            screenshots: [{ captured: true, path: 'gallery.png', kind: 'block', viewportId: 'desktop' }],
          },
        ],
      },
    ],
  };
  const mapping = mapSnapshot(snapshot);
  const candidate = mapping.pages[0].candidates[0];
  assert.equal(candidate.sectionType, 'media');
  assert.equal(candidate.assetPlan.target, 'items');
  // Exactly the two images that HAVE an accessible name are planned, each with
  // its own source alt text — never a shared or invented one.
  assert.deepEqual(
    candidate.assetPlan.entries.map((entry: { alt: string }) => entry.alt),
    ['A rehearsal in Kyiv', 'Opening night curtain']
  );
  // The third image has no text association, so it is unbindable and enumerated.
  const gap = mapping.pages[0].gaps[0];
  assert.equal(gap.why, 'image_missing_item_level_text_association');
  assert.match(gap.missingCapability, /carry no alt text/);

  const bound = bindMappingAssets(mapping, materializedArtifactRef).mapping.pages[0].candidates[0];
  assert.deepEqual(
    bound.section.data.items.map((item: { alt: string }) => item.alt),
    ['A rehearsal in Kyiv', 'Opening night curtain']
  );
  assert.equal(sectionInstanceSchema.safeParse(bound.section).success, true);
  // Alt text is extracted copy and is recorded as such, per planned asset.
  assert.deepEqual(
    candidate.provenance.assetFields.map((field: { path: string; source: string }) => [field.path, field.source]),
    [
      ['data.items.0.alt', 'extracted'],
      ['data.items.1.alt', 'extracted'],
    ]
  );

  // …and the source URLs reached NO field, bound or unbound.
  for (const asset of candidate.assetBindings) {
    assert.equal(JSON.stringify(bound.section).includes(asset.sourceUrl), false);
    assert.equal(JSON.stringify(candidate.assetPlan).includes(asset.sourceUrl), false);
  }
  for (const item of bound.section.data.items) assert.match(item.src, FIRST_PARTY_ASSET_PATH_RE);
});

test('a prohibited-media capture policy plans no asset field and records the gap instead', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const prohibited = {
    ...snapshot,
    capture: {
      ...snapshot.capture,
      policy: { ...snapshot.capture.policy, rights: { ...snapshot.capture.policy.rights, media: 'prohibited' } },
    },
  };
  const mapping = mapSnapshot(prohibited);
  assert.equal(mapping.policy.mediaRetentionAllowed, false);
  assert.equal(mapping.policy.mediaHandling, 'media_reuse_prohibited_by_capture_policy');
  assert.equal(mapping.summary.pendingAssetSections, 0);
  assert.equal(
    mapping.pages.flatMap((page: { candidates: Array<{ assetPlan?: unknown }> }) => page.candidates).some(
      (candidate: { assetPlan?: unknown }) => candidate.assetPlan
    ),
    false
  );
  const gaps = mapping.pages.flatMap((page: { gaps: Array<{ why: string }> }) => page.gaps);
  assert.ok(gaps.some((gap: { why: string }) => gap.why === 'media_reuse_prohibited_by_policy'));
  // No asset value anywhere in any emitted page body.
  for (const page of mapping.pages) {
    assert.equal(JSON.stringify(page.pageBody).includes('"src"'), false);
    assert.equal(JSON.stringify(page.pageBody).includes('AssetRef'), false);
  }
  // A policy that records NO media right at all fails closed the same way.
  const unstated = mapSnapshot({ ...snapshot, capture: { ...snapshot.capture, policy: undefined } });
  assert.equal(unstated.policy.mediaRetentionAllowed, false);
  assert.equal(unstated.summary.pendingAssetSections, 0);
});

test('the binder accepts only materialized first-party artifact references', () => {
  const section = { id: 's_test', type: 'media', data: { layout: 'single' } };
  const plan = { target: 'items', entries: [{ manifestRef: 'asset_one', alt: 'A caption' }] };
  const hostile = [
    'https://static.wixstatic.com/media/944663_abc~mv2.jpg',
    'http://example.com/one.jpg',
    '//cdn.example.com/one.jpg',
    'data:image/png;base64,AAAA',
    'src/assets/one.jpg',
    '/img/req/not-a-sha.jpg',
    'image/req/short.jpg',
    'one.jpg',
    '',
  ];
  for (const value of hostile) {
    assert.equal(firstPartyAssetPath(value), null, value);
    const outcome = bindSectionAssets(section, plan, () => value) as {
      error?: { code: string };
      section?: unknown;
    };
    assert.equal(outcome.error?.code, 'asset_binding_unresolved', value);
    assert.equal(outcome.section, undefined);
  }
  const good = bindSectionAssets(section, plan, materializedArtifactRef) as {
    error?: unknown;
    section: { data: { items: Array<{ src: string }> } };
  };
  assert.equal(good.error, undefined);
  assert.match(good.section.data.items[0].src, FIRST_PARTY_ASSET_PATH_RE);
});

test('an injected builder-CSS payload no longer declines the gallery underneath it', () => {
  // The 2 "clean semantic gallery data without injected CSS" gaps: the block's
  // TEXT was a Wix style payload, and the mapper declined the whole block —
  // losing the real gallery under it. The asset branch now runs first, so the
  // images bind and the CSS reaches no field at all.
  const cssPayload =
    'body { --wix-color-1: #ffffff; --wix-color-2: #000000; } .gallery { --wix-color-3: #cccccc; }';
  const assets = [1, 2, 3].map((n) => ({
    url: `https://static.wixstatic.com/media/still-${n}.jpg`,
    kind: 'image',
    alt: `Still ${n}`,
    downloaded: false,
  }));
  const mapping = mapSnapshot({
    schemaVersion: 'snapshot.v1',
    capture: {
      capturedAt: '2026-08-17T00:00:00.000Z',
      targetUrl: 'https://example.com/',
      origin: 'https://example.com',
      redacted: false,
      policy: { rights: { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' } },
    },
    diagnostics: { quarantined: [] },
    pages: [
      {
        pageId: 'page_films',
        url: 'https://example.com/filmography',
        path: '/filmography',
        title: 'Filmography',
        metaDescription: null,
        outline: [],
        navigation: { primary: [], footer: [] },
        assets,
        blocks: [
          {
            id: 'page_films_block_001',
            ordinal: 0,
            tag: 'section',
            text: { value: cssPayload },
            links: [],
            assetUrls: assets.map((asset) => asset.url),
            boundingBoxes: { desktop: { width: 100, height: 100 } },
            screenshots: [{ captured: true, path: 'films.png', kind: 'block', viewportId: 'desktop' }],
          },
        ],
      },
    ],
  });
  const page = mapping.pages[0];
  assert.equal(page.blockAccounting[0].status, 'mapped');
  assert.equal(page.candidates[0].sectionType, 'media');
  assert.equal(page.candidates[0].assetPlan.entries.length, 3);
  assert.equal(
    page.gaps.some((gap: { why: string }) => gap.why === 'embedded_builder_style_payload'),
    false
  );
  const bound = bindMappingAssets(mapping, materializedArtifactRef).mapping.pages[0];
  const body = JSON.stringify(bound.pageBody);
  // Not one byte of the style payload, and not one source URL, reached the body.
  assert.equal(body.includes('--wix-color-'), false);
  assert.equal(body.includes('static.wixstatic.com'), false);
  assert.equal(pageBodySchema.safeParse(bound.pageBody).success, true);
  assert.deepEqual(
    bound.pageBody.sections[0].data.items.map((item: { alt: string }) => item.alt),
    ['Still 1', 'Still 2', 'Still 3']
  );
});
