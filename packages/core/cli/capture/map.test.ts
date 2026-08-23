import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { navigationBodySchema } from '../../schema/bodies/navigation-v1.js';
import { COMPOSITION_MAX_IMAGES } from '../../schema/bodies/section-v1.js';
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
  COMPOSITION_MAX_IMAGES as CAPTURE_COMPOSITION_MAX_IMAGES,
  mapSnapshot,
  SUPPORTED_SECTION_TYPES,
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
      // T12.29: image-only sections now reach '/' (brand_row is a logo strip — images, no copy), so
      // "has text provenance" is no longer universal. The assertion that matters is unchanged and
      // now sharper: every copy field present is tagged `extracted`, AND a candidate with no copy
      // must be carrying imagery. That way "no text fields" can never quietly mean "the copy was
      // lost" — it has to mean "this section is not made of copy".
      const carriesImagery =
        (candidate.assetBindings?.length ?? 0) > 0 || (candidate.assetPlan?.entries?.length ?? 0) > 0;
      assert.ok(
        candidate.provenance.textFields.length > 0 || carriesImagery,
        `${candidate.sectionType} has neither extracted copy nor imagery`
      );
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

test('mapped coverage on the committed fixture is the recorded 17/19 = 89.47%', async () => {
  // The recorded progression on this one fixture:
  //   T12.14 brief:  3/19 = 15.79%  ->  10/19 = 52.63%  (asset-aware mapping)
  //   T12.29:       10/19 = 52.63%  ->  17/19 = 89.47%  (captured pages declare pageType 'clone')
  // The seven blocks recovered here are the ones the DTC `home` family used to discard from '/':
  // media, brand_row, content_split and prose all had nowhere legal to sit on a homepage. The 90%
  // bar is untouched and STILL unmet — deliberately: this asserts what the mapper does, not what
  // we would like it to do.
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const mapping = mapSnapshot(snapshot);
  const relevant = mapping.pages.flatMap((page: { blockAccounting: Array<{ status: string }> }) =>
    page.blockAccounting.filter(
      (entry: { status: string }) => !['duplicate', 'merged', 'ignored_noncontent'].includes(entry.status)
    )
  );
  const mapped = relevant.filter((entry: { status: string }) => ['mapped', 'mapped_with_gap'].includes(entry.status));
  assert.equal(relevant.length, 19);
  assert.equal(mapped.length, 17);
  assert.equal(Number((mapped.length / relevant.length).toFixed(4)), 0.8947);
  // 7 -> 10 (T12.29: asset-bearing sections survive on '/') -> 14 (T12.31: `composition` carries
  // imagery for blocks whose named type had no asset field at all). PENDING by design — a section
  // with an asset plan is deliberately incomplete until emission binds a first-party artifact.
  assert.equal(mapping.summary.pendingAssetSections, 14);
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

// ─── T12.23: the structured section types, validated against the REAL schemas ────────────────────
//
// map.structured.test.mjs proves the mapper CHOOSES these types. This proves the data it builds for
// them is actually acceptable to the platform — the only question emit cares about, because emit
// calls object_validate before and after every create. A builder that produces a plausible-looking
// object the Zod schema rejects would pass every test in the .mjs file and then fail live, one
// object_create at a time, on a real tenant.
const structuredSnapshot = (block: Record<string, unknown>, path = '/about') => ({
  schemaVersion: 'snapshot.v1',
  capture: {
    targetUrl: `https://example.test${path}`,
    origin: 'https://example.test',
    capturedAt: '2026-08-21T10:00:00.000Z',
    policy: { rights: { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' } },
  },
  pages: [
    {
      pageId: 'page_1',
      requestedUrl: `https://example.test${path}`,
      url: `https://example.test${path}`,
      path,
      status: 200,
      title: 'About',
      outline: [{ tag: 'h1', level: 1, text: 'About us', selector: '#h1' }],
      blocks: [
        {
          id: 'block_intro',
          ordinal: 0,
          tag: 'section',
          selector: '#intro',
          text: { value: 'About us We exist to do a thing.', length: 32, truncated: false },
          links: [],
          boundingBoxes: {},
          computedStyles: {},
          screenshots: [],
          assetUrls: [],
        },
        {
          id: 'block_under_test',
          ordinal: 1,
          tag: 'section',
          selector: '#target',
          links: [],
          boundingBoxes: {},
          computedStyles: {},
          screenshots: [],
          assetUrls: [],
          ...block,
        },
      ],
      assets: [],
      navigation: [],
      discoveredLinks: [],
      screenshots: [],
    },
  ],
  diagnostics: {},
});

const flatText = (value: string) => ({ value, length: value.length, truncated: false });

const STRUCTURED_CASES: Array<{ expected: string; block: Record<string, unknown> }> = [
  {
    expected: 'faq',
    block: {
      text: flatText('Do you fund students? Yes, every spring. Where are you based? Berlin.'),
      structure: {
        qa: [
          { q: 'Do you fund students?', a: 'Yes, every spring.' },
          { q: 'Where are you based?', a: 'Berlin.' },
        ],
      },
    },
  },
  {
    expected: 'testimonial',
    block: {
      text: flatText('They changed how we work. Dana Reyes, Director'),
      structure: { quotes: [{ quote: 'They changed how we work.', attribution: 'Dana Reyes, Director' }] },
    },
  },
  {
    expected: 'stats',
    block: {
      text: flatText('1,200 films preserved 48 countries reached'),
      structure: { lists: [{ ordered: false, items: ['1,200 films preserved', '48 countries reached'] }] },
    },
  },
  {
    expected: 'timeline',
    block: {
      text: flatText('1998 Founded in Berlin. 2004 First archive opened.'),
      structure: { lists: [{ ordered: false, items: ['1998 Founded in Berlin. The first office opened.', '2004 First archive opened.'] }] },
    },
  },
  {
    expected: 'steps',
    block: {
      text: flatText('Apply. Interview. Decide.'),
      structure: { lists: [{ ordered: true, items: ['Apply: send the form.', 'Interview: we call you.', 'Decide.'] }] },
    },
  },
  {
    expected: 'checklist',
    block: {
      text: flatText('Open access Peer reviewed Free to submit'),
      structure: { lists: [{ ordered: false, items: ['Open access', 'Peer reviewed', 'Free to submit'] }] },
    },
  },
  {
    expected: 'comparison_table',
    block: {
      text: flatText('Plan Basic Pro Archive access Bulk export'),
      structure: {
        tables: [
          {
            headers: ['Plan', 'Basic', 'Pro'],
            rows: [
              ['Archive access', '✓', '✓'],
              ['Bulk export', '✕', 'Up to 50/mo'],
            ],
          },
        ],
      },
    },
  },
];

for (const { expected, block } of STRUCTURED_CASES) {
  test(`T12.23: a mapped ${expected} section satisfies sectionInstanceSchema`, () => {
    const mapping = mapSnapshot(structuredSnapshot(block) as never);
    const section = mapping.pages[0].pageBody.sections.find((entry: { type: string }) => entry.type === expected);
    assert.ok(section, `the mapper did not produce a ${expected} section`);
    const parsed = sectionInstanceSchema.safeParse(section);
    assert.equal(
      parsed.success,
      true,
      `${expected} failed the platform schema: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`
    );
  });
}

test('T12.23: every structured page still satisfies pageBodySchema end to end', () => {
  for (const { block } of STRUCTURED_CASES) {
    const mapping = mapSnapshot(structuredSnapshot(block) as never);
    const parsed = pageBodySchema.safeParse(mapping.pages[0].pageBody);
    assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  }
});

test('T12.23: the classifier vocabulary contains only types the platform actually registers', () => {
  // The vocabulary is handed to block_classifier as the set it may choose from. A name in it that
  // the platform does not register would be a suggestion the builder accepts and object_validate
  // then rejects — a failure that only ever surfaces against a live tenant.
  for (const type of SUPPORTED_SECTION_TYPES) {
    assert.ok(
      (REGISTERED_SECTION_TYPES as readonly string[]).includes(type),
      `${type} is offered to the classifier but is not a registered section type`
    );
  }
});

test('T12.23: the capture-side home allowlist still mirrors the governed PageType registry', () => {
  // Unchanged by T12.23 and asserted here so it stays that way: capture must not quietly widen a
  // page type's allowlist to make a clone look better. `home` is narrow on purpose.
  const lookup = getPageTypeDefinition('home');
  assert.equal(lookup.ok, true);
  const governed = (lookup as { ok: true; definition: { allowedSections: readonly string[] | 'any' } }).definition;
  assert.notEqual(governed.allowedSections, 'any');
  assert.deepEqual(
    [...(CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS.home as Set<string>)].sort(),
    [...(governed.allowedSections as readonly string[])].sort()
  );
});

// ─── T12.31: the composable section ──────────────────────────────────────────────────────────────

test('T12.31: the capture-side image cap mirrors the governed schema', () => {
  // map.mjs is a standalone .mjs and cannot import the schema, so the bound is restated there. A
  // silent divergence would let the mapper plan more images than a composition can legally hold —
  // which surfaces only as a validation failure against a live tenant.
  assert.equal(CAPTURE_COMPOSITION_MAX_IMAGES, COMPOSITION_MAX_IMAGES);
});

test('T12.31: a BOUND composition satisfies sectionInstanceSchema', () => {
  // The question that matters: not whether the mapper produces compositions, but whether what it
  // produces is acceptable to the platform once emission binds its artifacts.
  const urls = ['https://example.test/a.jpg', 'https://example.test/b.jpg', 'https://example.test/c.jpg'];
  const snapshot = structuredSnapshot({
    text: flatText(
      'Our partners include several institutions, described at length below in copy that is clearly substantive.'
    ),
    links: [{ label: 'Read more', href: 'https://example.test/partners' }],
    assetUrls: urls,
  }) as unknown as { pages: Array<{ assets: unknown[] }> };
  // Images are only bindable when the page manifest declares them WITH alt text — the mapper's own
  // rule, so the fixture has to satisfy it rather than route around it.
  snapshot.pages[0].assets = urls.map((url, index) => ({ url, kind: 'image', alt: `Partner ${index + 1}` }));
  const mapping = mapSnapshot(snapshot as never);
  const page = mapping.pages[0];
  const candidate = page.candidates.find((entry: { sectionType: string }) => entry.sectionType === 'composition');
  assert.ok(candidate, 'the mixed block became a composition');

  // Unbound it is deliberately INCOMPLETE — the two-phase contract.
  assert.equal(sectionInstanceSchema.safeParse(candidate.section).success, false);

  const bound = bindSectionAssets(
    candidate.section,
    candidate.assetPlan,
    (manifestRef: string) => `image/capture/${'a'.repeat(64)}.jpg`.replace('aaaa', manifestRef.slice(-4).padEnd(4, 'a'))
  );
  assert.ok(!bound.error, `binding failed: ${JSON.stringify(bound.error)}`);
  const parsed = sectionInstanceSchema.safeParse(bound.section);
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));

  // Its image blocks address real positions in the bound images array.
  const data = bound.section.data as { images: unknown[]; blocks: Array<{ kind: string; imageIndex?: number }> };
  for (const block of data.blocks) {
    if (block.kind !== 'image') continue;
    assert.ok(typeof block.imageIndex === 'number' && block.imageIndex < data.images.length);
  }
  // Nothing was dropped: the copy and the link both survived the re-type.
  assert.ok(data.blocks.some((block) => block.kind === 'text'));
  assert.ok(data.blocks.some((block) => block.kind === 'actions'));
});

test('T12.31: binding REPAIRS image indexes when a planned image does not materialize', () => {
  // The hazard: if a planned image is missing and the survivors simply shift up, every later block
  // points at the WRONG picture — worse than pointing at none. Blocks are rewritten against what
  // actually survived, and a block whose image did not is removed.
  const section = {
    id: 's_comp',
    type: 'composition',
    data: {
      blocks: [
        { kind: 'text', body: '<p>Copy.</p>' },
        { kind: 'image', imageIndex: 0 },
        { kind: 'image', imageIndex: 1 },
        { kind: 'image', imageIndex: 2 },
      ],
    },
  };
  const assetPlan = {
    target: 'composition',
    entries: [
      { manifestRef: 'asset_one', alt: 'One' },
      { manifestRef: 'asset_two', alt: 'Two' },
      { manifestRef: 'asset_three', alt: 'Three' },
    ],
  };
  // The MIDDLE image fails to materialize — the case that would corrupt a naive shift.
  const bound = bindSectionAssets(section as never, assetPlan as never, (ref: string) =>
    ref === 'asset_two' ? null : `image/capture/${'b'.repeat(64)}.jpg`
  );
  assert.ok(!bound.error);
  const data = bound.section.data as { images: unknown[]; blocks: Array<{ kind: string; imageIndex?: number }> };
  assert.equal(data.images.length, 2);
  const imageBlocks = data.blocks.filter((block) => block.kind === 'image');
  assert.equal(imageBlocks.length, 2, 'the block for the unmaterialized image was removed');
  assert.deepEqual(imageBlocks.map((block) => block.imageIndex), [0, 1]);
  assert.ok(data.blocks[0].kind === 'text', 'the copy is untouched');
});
