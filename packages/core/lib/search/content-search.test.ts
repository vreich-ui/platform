import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANONICAL_SCORE,
  normalizeRoutePath,
  rankSearchDocs,
  scoreDoc,
  slugify,
  tokenize,
  type SearchDoc,
} from './content-search.js';

const doc = (overrides: Partial<SearchDoc> = {}): SearchDoc => ({
  object_id: 'req_nac_skin_20260901_01',
  object_type: 'content_item',
  status: 'active',
  published: true,
  published_time: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  slug: 'nac-for-skin-health',
  title: 'NAC for Skin Health',
  description: 'What N-acetylcysteine does for the skin barrier.',
  route: '/nac-for-skin-health',
  seo_title: 'NAC for Skin Health — the evidence',
  seo_description: 'Glutathione, oxidative stress and the skin.',
  category: 'ingredients',
  tags: ['nac', 'glutathione', 'antioxidants'],
  headings: ['What NAC is', 'How it reaches the skin'],
  aliases: [],
  request_id: 'req_nac_skin_20260901_01',
  ...overrides,
});

const other = () =>
  doc({
    object_id: 'req_retinol_20260801_01',
    slug: 'retinol-without-the-peeling',
    title: 'Retinol Without the Peeling',
    description: 'A tolerance-building schedule.',
    route: '/retinol-without-the-peeling',
    seo_title: 'Retinol without the peeling',
    seo_description: 'Start low, go slow.',
    category: 'routines',
    tags: ['retinoids', 'irritation'],
    headings: ['Why it stings'],
    request_id: 'req_retinol_20260801_01',
    published_time: '2026-08-01T00:00:00.000Z',
  });

// ─── URL / route normalization ───────────────────────────────────────────────

test('a full URL, a path and a bare slug all normalize to the same route', () => {
  const expected = '/nac-for-skin-health';
  for (const input of [
    'https://drluriescience.netlify.app/nac-for-skin-health',
    'https://drluriescience.netlify.app/nac-for-skin-health/',
    'https://drluriescience.netlify.app/nac-for-skin-health?utm_source=x#top',
    '/nac-for-skin-health',
    'nac-for-skin-health',
    '  /NAC-For-Skin-Health/  ',
  ]) {
    assert.equal(normalizeRoutePath(input), expected, input);
  }
});

test('the site root normalizes to "/" rather than to nothing', () => {
  assert.equal(normalizeRoutePath('https://drluriescience.netlify.app/'), '/');
  assert.equal(normalizeRoutePath('/'), '/');
});

test('a malformed percent-escape is data, not a thrown lookup', () => {
  assert.doesNotThrow(() => normalizeRoutePath('https://example.com/100%-pure'));
});

test('slugify and tokenize agree with how an editor types a headline', () => {
  assert.equal(slugify('NAC for Skin Health'), 'nac-for-skin-health');
  assert.equal(slugify('nac_for_skin_health'), 'nac-for-skin-health');
  // Stopwords go, so "for" does not make every article a partial match…
  assert.deepEqual(tokenize('NAC for Skin Health'), ['nac', 'skin', 'health']);
  // …unless dropping them would leave nothing to search for.
  assert.deepEqual(tokenize('the'), ['the']);
});

// ─── identity lookups resolve outright ───────────────────────────────────────

test('an exact slug scores 1.0 and comes back as canonical_result', () => {
  const ranked = rankSearchDocs([doc(), other()], { slug: 'nac-for-skin-health' });
  assert.equal(ranked.results[0]?.object_id, 'req_nac_skin_20260901_01');
  assert.equal(ranked.results[0]?.score, 1);
  assert.equal(ranked.canonical_result?.object_id, 'req_nac_skin_20260901_01');
});

test('a full URL resolves the same object as the slug does', () => {
  const ranked = rankSearchDocs([doc(), other()], {
    url: 'https://drluriescience.netlify.app/nac-for-skin-health',
  });
  assert.equal(ranked.canonical_result?.object_id, 'req_nac_skin_20260901_01');
});

test('an exact title resolves canonically', () => {
  const ranked = rankSearchDocs([doc(), other()], { title: 'NAC for Skin Health' });
  assert.equal(ranked.canonical_result?.object_id, 'req_nac_skin_20260901_01');
  assert.ok((ranked.results[0]?.score ?? 0) > CANONICAL_SCORE);
});

test('a request id resolves canonically — the id an agent may already hold', () => {
  const ranked = rankSearchDocs([doc(), other()], { request_id: 'req_nac_skin_20260901_01' });
  assert.equal(ranked.canonical_result?.object_id, 'req_nac_skin_20260901_01');
});

// ─── ranked search ───────────────────────────────────────────────────────────

test('a free-text query ranks the right article first without resolving canonically', () => {
  const ranked = rankSearchDocs([other(), doc()], { query: 'NAC glutathione skin' });
  assert.equal(ranked.results[0]?.object_id, 'req_nac_skin_20260901_01');
  // Three loose keywords are evidence, not proof — the caller should look at
  // the list rather than be handed a single answer to act on.
  assert.equal(ranked.canonical_result, undefined);
});

test('an unrelated query returns nothing rather than the least-bad row', () => {
  const ranked = rankSearchDocs([doc(), other()], { query: 'shipping policy refunds' });
  assert.deepEqual(ranked.results, []);
});

test('limit truncates the ranked list and is clamped to the documented maximum', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    doc({ object_id: `req_${i}`, slug: `skin-health-${i}`, title: `Skin Health ${i}`, route: `/skin-health-${i}` })
  );
  assert.equal(rankSearchDocs(many, { query: 'skin health' }, 3).results.length, 3);
  assert.equal(rankSearchDocs(many, { query: 'skin health' }, 999).results.length, 8);
});

// ─── typo tolerance ──────────────────────────────────────────────────────────

test('a mistyped slug still finds the article, and fuzzy:false refuses to guess', () => {
  const fuzzy = rankSearchDocs([doc(), other()], { slug: 'nac-for-skin-helth' });
  assert.equal(fuzzy.results[0]?.object_id, 'req_nac_skin_20260901_01');
  assert.ok((fuzzy.results[0]?.score ?? 0) < 1, 'an approximate hit must not claim an exact score');

  const exact = rankSearchDocs([doc(), other()], { slug: 'nac-for-skin-helth', fuzzy: false });
  assert.deepEqual(exact.results, []);
});

test('a short token is not fuzzy-matched — "nac" and "nap" are different words, not a typo', () => {
  const { score } = scoreDoc(doc(), { query: 'nap' });
  assert.equal(score, 0);
});

// ─── ambiguity is reported, never resolved ───────────────────────────────────

test('two objects that both match perfectly yield NO canonical_result', () => {
  const twin = doc({ object_id: 'req_duplicate_01', request_id: 'req_duplicate_01' });
  const ranked = rankSearchDocs([doc(), twin], { slug: 'nac-for-skin-health' });
  assert.equal(ranked.results.length, 2);
  assert.equal(ranked.results[0]?.score, 1);
  assert.equal(
    ranked.canonical_result,
    undefined,
    'a contested slug is a data problem — picking one would launder it into a wrong edit'
  );
});

test('criteria are independently sufficient: a perfect slug is not diluted by a wrong title', () => {
  const { score, matched_on } = scoreDoc(doc(), {
    slug: 'nac-for-skin-health',
    title: 'Something Else Entirely',
  });
  assert.equal(score, 1);
  assert.equal(matched_on[0], 'slug');
});

// ─── ordering stability ──────────────────────────────────────────────────────

test('equal scores break ties newest-first, then by id — never at random', () => {
  const older = doc({
    object_id: 'req_a',
    slug: 'skin-health',
    route: '/skin-health',
    published_time: '2026-01-01T00:00:00.000Z',
  });
  const newer = doc({
    object_id: 'req_b',
    slug: 'skin-health',
    route: '/skin-health',
    published_time: '2026-08-01T00:00:00.000Z',
  });
  const ranked = rankSearchDocs([older, newer], { slug: 'skin-health' });
  assert.deepEqual(
    ranked.results.map((result) => result.object_id),
    ['req_b', 'req_a']
  );
});
