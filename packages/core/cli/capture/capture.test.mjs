import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isUrlWithinPolicy,
  isLikelyHtmlPage,
  normalizeCrawlUrl,
  redactSnapshot,
  stablePageId,
  validateCapturePolicy,
} from './snapshot-v1.mjs';

const policy = validateCapturePolicy({
  maxPages: 25_000,
  allowedCrawlOrigins: ['https://example.com'],
  allowedPathPrefixes: ['/'],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 1500,
  authenticatedAccess: 'prohibited',
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
