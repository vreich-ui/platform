// T12.23 — the seven section types the mapper could not produce until the crawl stopped throwing
// their shape away. These drive `mapSnapshot` end-to-end rather than the builders directly, because
// the thing that was broken was never a builder: it was that no path reached one.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SUPPORTED_SECTION_TYPES, STRUCTURED_BUILDERS, mapSnapshot } from './map.mjs';

const ORIGIN = 'https://example.test';

/** Minimal snapshot: a titled first block (which becomes the lede) plus the block under test. */
const snapshotWith = (block, { path = '/about' } = {}) => ({
  schemaVersion: 'snapshot.v1',
  capture: {
    targetUrl: `${ORIGIN}${path}`,
    origin: ORIGIN,
    capturedAt: '2026-08-21T10:00:00.000Z',
    policy: { rights: { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' } }
  },
  pages: [
    {
      pageId: 'page_1',
      requestedUrl: `${ORIGIN}${path}`,
      url: `${ORIGIN}${path}`,
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
          assetUrls: []
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
          ...block
        }
      ],
      assets: [],
      navigation: [],
      discoveredLinks: [],
      screenshots: []
    }
  ],
  diagnostics: {}
});

const candidateFor = (snapshot, blockId) => {
  const mapping = mapSnapshot(snapshot);
  const page = mapping.pages[0];
  const candidate = (page.candidates ?? []).find((entry) => (entry.sourceBlockIds ?? []).includes(blockId));
  return { mapping, page, candidate };
};

const flat = (value) => ({ value, length: value.length, truncated: false });

test('the classifier vocabulary and the builder switch stay in lockstep', () => {
  // A builder with no vocabulary entry can never be suggested; a vocabulary entry with no builder is
  // accepted and then silently produces nothing. Both are failures, and both are invisible at
  // runtime — which is exactly why they are asserted here.
  for (const [type] of STRUCTURED_BUILDERS) {
    assert.ok(SUPPORTED_SECTION_TYPES.has(type), `${type} builds but cannot be suggested`);
  }
});

test('a <dl> of questions becomes an faq, not a prose blob', () => {
  const { candidate } = candidateFor(
    snapshotWith({
      text: flat('Frequently asked Do you fund students? Yes, every spring. Where are you based? Berlin.'),
      structure: {
        qa: [
          { q: 'Do you fund students?', a: 'Yes, every spring.' },
          { q: 'Where are you based?', a: 'Berlin.' }
        ]
      }
    }),
    'block_under_test'
  );
  assert.equal(candidate.sectionType, 'faq');
  assert.equal(candidate.data.items.length, 2);
  assert.equal(candidate.data.items[0].q, 'Do you fund students?');
  assert.match(candidate.data.items[0].a, /^<p>Yes, every spring\.<\/p>$/);
});

test('a blockquote with a cite becomes a testimonial, and the attribution is not left inside the quote', () => {
  const { candidate } = candidateFor(
    snapshotWith({
      text: flat('They changed how we work. Dana Reyes, Director'),
      structure: { quotes: [{ quote: 'They changed how we work.', attribution: 'Dana Reyes, Director' }] }
    }),
    'block_under_test'
  );
  assert.equal(candidate.sectionType, 'testimonial');
  assert.equal(candidate.data.quotes[0].quote, 'They changed how we work.');
  assert.equal(candidate.data.quotes[0].attribution, 'Dana Reyes, Director');
});

test('figure-led list items become stats, and a single figure does not', () => {
  const two = candidateFor(
    snapshotWith({
      text: flat('1,200 films preserved 48 countries reached'),
      structure: { lists: [{ ordered: false, items: ['1,200 films preserved', '48 countries reached'] }] }
    }),
    'block_under_test'
  ).candidate;
  assert.equal(two.sectionType, 'stats');
  assert.deepEqual(two.data.items, [
    { value: '1,200', label: 'films preserved' },
    { value: '48', label: 'countries reached' }
  ]);

  // The schema's floor is two. One figure is a sentence; it must fall through, not become a strip.
  const one = candidateFor(
    snapshotWith({
      text: flat('1,200 films preserved since the foundation was established in Berlin.'),
      structure: { lists: [{ ordered: false, items: ['1,200 films preserved since the foundation was established in Berlin.'] }] }
    }),
    'block_under_test'
  ).candidate;
  assert.notEqual(one.sectionType, 'stats');
});

test('year-led list items become a timeline with the year as the period', () => {
  const { candidate } = candidateFor(
    snapshotWith({
      text: flat('1998 Founded in Berlin. 2004 First archive opened.'),
      structure: { lists: [{ ordered: false, items: ['1998 Founded in Berlin. The first office opened.', '2004 First archive opened.'] }] }
    }),
    'block_under_test'
  );
  assert.equal(candidate.sectionType, 'timeline');
  assert.equal(candidate.data.milestones.length, 2);
  assert.equal(candidate.data.milestones[0].period, '1998');
  assert.equal(candidate.data.milestones[0].label, 'Founded in Berlin');
});

test('an ordered list becomes steps; the same items unordered do not', () => {
  const ordered = candidateFor(
    snapshotWith({
      text: flat('Apply. Interview. Decide.'),
      structure: { lists: [{ ordered: true, items: ['Apply: send the form.', 'Interview: we call you.', 'Decide.'] }] }
    }),
    'block_under_test'
  ).candidate;
  assert.equal(ordered.sectionType, 'steps');
  assert.equal(ordered.data.items[0].title, 'Apply');

  // <ol> is the author saying sequence matters. Inferring it from <ul> would invent that claim.
  const unordered = candidateFor(
    snapshotWith({
      text: flat('Apply. Interview. Decide.'),
      structure: { lists: [{ ordered: false, items: ['Apply: send the form.', 'Interview: we call you.', 'Decide.'] }] }
    }),
    'block_under_test'
  ).candidate;
  assert.notEqual(unordered.sectionType, 'steps');
});

test('short unordered bullets become a checklist; long ones stay prose', () => {
  const short = candidateFor(
    snapshotWith({
      text: flat('Open access Peer reviewed Free to submit'),
      structure: { lists: [{ ordered: false, items: ['Open access', 'Peer reviewed', 'Free to submit'] }] }
    }),
    'block_under_test'
  ).candidate;
  assert.equal(short.sectionType, 'checklist');
  assert.deepEqual(short.data.items, ['Open access', 'Peer reviewed', 'Free to submit']);

  const long = 'This bullet keeps going well past the point where it is a bullet and becomes a paragraph that happens to sit inside a list element.';
  const wordy = candidateFor(
    snapshotWith({ text: flat(long), structure: { lists: [{ ordered: false, items: [long, long] }] } }),
    'block_under_test'
  ).candidate;
  assert.notEqual(wordy.sectionType, 'checklist');
});

test('a table becomes a comparison_table, and tick/cross cells become booleans', () => {
  const { candidate } = candidateFor(
    snapshotWith({
      text: flat('Plan Basic Pro Archive access yes yes Bulk export no yes'),
      structure: {
        tables: [
          {
            headers: ['Plan', 'Basic', 'Pro'],
            rows: [
              ['Archive access', '✓', '✓'],
              ['Bulk export', '✕', 'Up to 50/mo']
            ]
          }
        ]
      }
    }),
    'block_under_test'
  );
  assert.equal(candidate.sectionType, 'comparison_table');
  assert.deepEqual(candidate.data.columns, [{ label: 'Basic' }, { label: 'Pro' }]);
  assert.deepEqual(candidate.data.rows[0], { label: 'Archive access', cells: [true, true] });
  assert.deepEqual(candidate.data.rows[1], { label: 'Bulk export', cells: [false, 'Up to 50/mo'] });
});

test('a snapshot with NO structure key maps exactly as it did before T12.23', () => {
  // The regression guard for every capture taken before the crawl learned to keep shape.
  const { candidate } = candidateFor(
    snapshotWith({ text: flat('Open access Peer reviewed Free to submit and a good deal more besides.') }),
    'block_under_test'
  );
  assert.ok(candidate, 'the block still maps');
  assert.equal(candidate.sectionType, 'prose');
});

test('the home PageType now reaches checklist — a type it always allowed and capture could never build', () => {
  // Before T12.23 the mapper could produce exactly two of the six section types `home` permits
  // (hero and bio), so a homepage clone was structurally capped no matter what the source looked
  // like. `checklist` was allowed the whole time; nothing could build one.
  const { candidate, page } = candidateFor(
    snapshotWith(
      {
        text: flat('Open access Peer reviewed Free to submit'),
        structure: { lists: [{ ordered: false, items: ['Open access', 'Peer reviewed', 'Free to submit'] }] }
      },
      { path: '/' }
    ),
    'block_under_test'
  );
  assert.equal(page.pageBody.pageType, 'home');
  assert.equal(candidate.sectionType, 'checklist');
});

test('a structured type the PageType forbids is skipped, never emitted as a disallowed section', () => {
  // `home` allows hero/checklist/content_grid/bio/newsletter_signup/shared_ref — deliberately, per
  // the platform PageType registry. A testimonial must not be produced for the homepage at all;
  // whether the block then maps or gaps is the text path's business, but it must never come out
  // typed as something the page type refuses.
  const { candidate } = candidateFor(
    snapshotWith(
      {
        text: flat('They changed how we work, and we would not go back to the old way of doing any of it.'),
        structure: { quotes: [{ quote: 'They changed how we work, and we would not go back to the old way of doing any of it.' }] }
      },
      { path: '/' }
    ),
    'block_under_test'
  );
  assert.notEqual(candidate?.sectionType, 'testimonial');
});
