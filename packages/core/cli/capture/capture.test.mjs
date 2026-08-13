import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isUrlWithinPolicy,
  isLikelyHtmlPage,
  normalizeCrawlUrl,
  parseCapturePolicy,
  readProjectCapturePolicy,
  redactSnapshot,
  stablePageId,
  validateCapturePolicy,
} from './snapshot-v1.mjs';

// A complete ProjectCapturePolicy — the one shape every entry point takes.
const policy = validateCapturePolicy({
  maxPages: 25_000,
  allowedCrawlOrigins: ['https://example.com'],
  allowedPathPrefixes: ['/'],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 1500,
  authenticatedAccess: 'prohibited',
  rights: { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' },
  designReferences: [],
  fidelity: { mode: 'source_faithful', sourceDesignTreatment: 'source_content_and_design' },
});

test('capture limits are project-owned rather than globally capped', () => {
  assert.equal(policy.maxPages, 25_000);
});

test('same-origin and path bounds fail closed', () => {
  assert.equal(isUrlWithinPolicy('https://example.com/inside#fragment', policy, 'https://example.com'), true);
  assert.equal(isUrlWithinPolicy('https://cdn.example.com/inside', policy, 'https://example.com'), false);
  assert.equal(isUrlWithinPolicy('javascript:alert(1)', policy, 'https://example.com'), false);
});

test('URL normalization and page ids are stable across fragments', () => {
  assert.equal(normalizeCrawlUrl('https://example.com/a#one'), 'https://example.com/a');
  assert.equal(stablePageId('https://example.com/a#one'), stablePageId('https://example.com/a#two'));
});

test('download links are retained as resources rather than navigated as pages', () => {
  assert.equal(isLikelyHtmlPage('https://example.com/about'), true);
  assert.equal(isLikelyHtmlPage('https://example.com/about.html'), true);
  assert.equal(isLikelyHtmlPage('https://example.com/report.pdf?download=1'), false);
  assert.equal(isLikelyHtmlPage('https://example.com/release.docx'), false);
});

test('fixture redaction preserves structure and asset URLs but no screenshot bytes', () => {
  const redacted = redactSnapshot({
    capture: { redacted: false },
    pages: [
      {
        title: 'A title',
        metaDescription: 'A description',
        outline: [{ text: 'Heading' }],
        navigation: { primary: [{ label: 'Home' }], footer: [] },
        blocks: [
          {
            text: { value: 'Body' },
            accessibleName: 'Region',
            links: [{ label: 'More' }],
            screenshots: [{ path: 'block.png', sha256: 'secret-hash', byteLength: 12 }],
          },
        ],
        screenshots: [{ path: 'full.png', sha256: 'secret-hash', byteLength: 34 }],
        assets: [{ url: 'https://example.com/image.jpg', alt: 'Portrait', label: 'Download', downloaded: false }],
      },
    ],
  });
  assert.equal(redacted.capture.redacted, true);
  assert.equal(redacted.pages[0].title, '[redacted:7 chars]');
  assert.equal(redacted.pages[0].assets[0].url, 'https://example.com/image.jpg');
  assert.equal(redacted.pages[0].assets[0].alt, '[redacted:8 chars]');
  assert.equal(redacted.pages[0].assets[0].label, '[redacted:8 chars]');
  assert.equal(redacted.pages[0].screenshots[0].sha256, undefined);
  assert.equal(redacted.pages[0].screenshots[0].committed, false);
});

test('unsafe policy posture is rejected instead of loosened', () => {
  assert.throws(() => validateCapturePolicy({ ...policy, respectRobots: false }), /respectRobots=true/);
  assert.throws(() => validateCapturePolicy({ ...policy, sameOriginOnly: false }), /sameOriginOnly=true/);
  assert.throws(() => validateCapturePolicy({ ...policy, authenticatedAccess: 'allowed' }), /authenticatedAccess/);
});

test('the registry deny-all default is well-formed but authorizes no crawl', () => {
  // DEFAULT_PROJECT_CAPTURE_POLICY, verbatim: a project has to raise it.
  const denyAll = {
    maxPages: 0,
    allowedCrawlOrigins: [],
    allowedPathPrefixes: [],
    sameOriginOnly: true,
    respectRobots: true,
    concurrency: 1,
    delayMs: 1500,
    authenticatedAccess: 'prohibited',
    rights: { content: 'prohibited', media: 'prohibited' },
    designReferences: [],
    fidelity: { mode: 'source_faithful', sourceDesignTreatment: 'source_content_and_design' },
  };
  assert.deepEqual(parseCapturePolicy(denyAll), denyAll);
  assert.throws(() => validateCapturePolicy(denyAll), /denies all capture/);
});

test('the canonical policy shape is the only shape accepted', () => {
  assert.throws(() => parseCapturePolicy({ ...policy, maxCrawlPages: 5 }), /unknown field maxCrawlPages/);
  assert.throws(() => parseCapturePolicy({ ...policy, rights: undefined }), /capturePolicy.rights must be an object/);
  assert.throws(() => parseCapturePolicy({ ...policy, fidelity: undefined }), /capturePolicy.fidelity must be an object/);
  assert.throws(() => parseCapturePolicy({ ...policy, designReferences: undefined }), /must be an array/);
  assert.throws(() => parseCapturePolicy({ ...policy, rights: { content: 'anything', media: 'prohibited' } }), /rights.content/);
  assert.throws(() => parseCapturePolicy({ ...policy, concurrency: 33 }), /concurrency must be a safe integer between 1 and 32/);
  assert.throws(() => parseCapturePolicy({ ...policy, delayMs: -1 }), /delayMs must be a safe integer/);
  assert.throws(() => parseCapturePolicy({ ...policy, allowedCrawlOrigins: ['http://example.com'] }), /must be an HTTPS origin/);
  assert.throws(() => parseCapturePolicy({ ...policy, allowedCrawlOrigins: ['https://example.com/path'] }), /no path, query, or fragment/);
  assert.throws(() => parseCapturePolicy({ ...policy, allowedPathPrefixes: ['news'] }), /absolute path prefix/);
  assert.throws(
    () => parseCapturePolicy({ ...policy, designReferences: [{ origin: 'https://ref.example.net', purpose: 'design_inspiration_only', crawlAllowed: true, contentReuse: 'prohibited', mediaReuse: 'prohibited' }] }),
    /crawlAllowed must be false/
  );
  assert.throws(
    () => parseCapturePolicy({ ...policy, fidelity: { ...policy.fidelity, coverageRubricOverride: { minimumMappedBlockCoverage: 0.5 } } }),
    /requireCompleteTokens must be a boolean/
  );
});

test('the project response envelope resolves to the same policy either spelling', async () => {
  const canonical = { project: { projectId: 'platform', capturePolicy: policy } };
  assert.deepEqual(readProjectCapturePolicy(canonical), policy);
  assert.deepEqual(readProjectCapturePolicy({ data: canonical }), policy);
  assert.deepEqual(readProjectCapturePolicy({ project: { id: 'platform', capture_policy: policy } }), policy);
  assert.equal(readProjectCapturePolicy({ project: { id: 'platform' } }), null);
});

test('the committed policy template is a complete, crawlable ProjectCapturePolicy', async () => {
  const template = JSON.parse(
    await readFile(new URL('./fixtures/capture-policy.template.json', import.meta.url), 'utf8')
  );
  // The runbook's copy-me example must stay executable, not merely illustrative.
  assert.deepEqual(validateCapturePolicy(template), template);
  assert.equal(template.authenticatedAccess, 'prohibited');
  assert.equal(template.fidelity.coverageRubricOverride.minimumMappedBlockCoverage, 0.9);
});

test('the recorded 2026-08-13 Zilberman policy round-trips through validation unchanged', async () => {
  const snapshot = JSON.parse(
    await readFile(new URL('./fixtures/zilberman.snapshot.v1.redacted.json', import.meta.url), 'utf8')
  );
  const recorded = snapshot.capture.policy;
  // The live CMS-Agent project record for this target, as the acceptance run
  // recorded it. Both entry points must return it byte-for-byte identical.
  assert.deepEqual(parseCapturePolicy(recorded), recorded);
  assert.deepEqual(validateCapturePolicy(recorded), recorded);
  assert.deepEqual(
    readProjectCapturePolicy({ project: { projectId: 'platform', capturePolicy: recorded } }),
    recorded
  );
  assert.equal(recorded.maxPages, 20);
  assert.equal(recorded.rights.content, 'retain_allowed_origin_content');
  assert.equal(recorded.designReferences[0].crawlAllowed, false);
  assert.equal(recorded.fidelity.mode, 'design_inspired');
  assert.equal(recorded.fidelity.coverageRubricOverride, undefined);
});

test('the committed spike fixture is redacted, complete, and byte-free', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/zilberman.snapshot.v1.redacted.json', import.meta.url), 'utf8')
  );
  assert.equal(fixture.schemaVersion, 'snapshot.v1');
  assert.equal(fixture.capture.redacted, true);
  assert.equal(fixture.pages.length, 5);
  assert.deepEqual(fixture.diagnostics.quarantined, []);

  const serialized = JSON.stringify(fixture);
  assert.equal(serialized.includes('data:image'), false);
  for (const page of fixture.pages) {
    assert.match(page.title, /^\[redacted:\d+ chars\]$/);
    for (const screenshot of [...page.screenshots, ...page.blocks.flatMap((block) => block.screenshots)]) {
      assert.equal(screenshot.captured, true);
      assert.equal(screenshot.committed, false);
      assert.equal(screenshot.sha256, undefined);
      assert.equal(screenshot.byteLength, undefined);
    }
  }
});
