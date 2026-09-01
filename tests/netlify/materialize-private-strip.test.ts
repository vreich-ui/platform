import assert from 'node:assert/strict';
import test from 'node:test';

import { contentItemBodySchema } from '../../packages/core/schema/bodies/content-item-v1.js';
import { materialize } from '../../packages/core/server/lib/materialize.js';

/**
 * W6 Q — private node annotations never reach git.
 *
 * `node.private` (strategy / intent / agentNotes) is the persuasion
 * architecture of an article. The renderer has always stripped it, so reader
 * HTML was clean — but the derived export is COMMITTED to the repository, and
 * it carried `private` verbatim for all ten nodes of the article published in
 * the 2026-08-31 acceptance run. Reader HTML clean, git not.
 *
 * Ruled: strip regardless of repository visibility. Three things have to hold
 * at once — the export has no `private` at any depth, the record handed to the
 * materializer is not mutated (the object store keeps the annotation layer),
 * and the stripped export still round-trips through the body schema so the
 * build can read it.
 */
const META = { at: '2026-09-01T12:00:00.000Z', record_version: 7, exportRoot: 'sites/drlurie/data/site' };

const ARTICLE_BODY = {
  slug: 'private-strip-probe',
  title: 'An article whose nodes carry an annotation layer',
  deck: 'Every node here has a private block; none of them may reach the export.',
  description: 'A fixture article used to pin that the git materializer drops the annotation layer.',
  author: 'Dr. Lurie',
  taxonomy: { category: 'skin-health', tags: ['skincare-basics'] },
  seo: { meta_description: 'A fixture article used to pin that the git materializer drops node.private.' },
  nodes: [
    {
      id: 'n_01',
      kind: 'content' as const,
      public: { body: '<p>An opening paragraph a reader is meant to see.</p>' },
      private: { strategy: 'hook', intent: 'educate', agentNotes: 'open on the sensation, not the ingredient' },
    },
    {
      id: 'n_02',
      kind: 'content' as const,
      public: { title: 'The middle', body: '<p>A second paragraph a reader is meant to see.</p>' },
      private: { strategy: 'agitation', intent: 'persuade' },
    },
    {
      id: 'n_03',
      kind: 'action' as const,
      public: { title: 'Read more', body: '<p>A closing block.</p>', ctaText: 'More notes' },
      private: { strategy: 'recommendation', intent: 'convert' },
    },
  ],
};

/** Depth-first: does any key named `private` survive anywhere in the tree? */
const findPrivatePaths = (value: unknown, path: string[] = []): string[] => {
  if (Array.isArray(value)) return value.flatMap((item, index) => findPrivatePaths(item, [...path, String(index)]));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    key === 'private' ? [[...path, key].join('.')] : findPrivatePaths(nested, [...path, key])
  );
};

test('the git export carries no private key at any depth', () => {
  const file = materialize('content_item', 'req_probe_private_20260901_01', ARTICLE_BODY, META);
  assert.equal(file.path, 'sites/drlurie/data/site/articles/req_probe_private_20260901_01.json');

  const exported = JSON.parse(file.content) as Record<string, unknown>;
  assert.deepEqual(
    findPrivatePaths(exported),
    [],
    'the committed export is the file the strategy leak was found in — it must be clean'
  );
  assert.ok(!file.content.includes('agitation'), 'no strategy vocabulary survives into the file text');
  assert.ok(!file.content.includes('agentNotes'));
});

test('public content is untouched — only the annotation layer goes', () => {
  const file = materialize('content_item', 'req_probe_private_20260901_01', ARTICLE_BODY, META);
  const exported = JSON.parse(file.content) as { nodes: { id: string; kind: string; public: unknown }[] };

  assert.equal(exported.nodes.length, 3);
  assert.deepEqual(
    exported.nodes.map((node) => node.id),
    ['n_01', 'n_02', 'n_03'],
    'node order and identity are rendering data and must survive'
  );
  assert.deepEqual(exported.nodes[0].public, ARTICLE_BODY.nodes[0].public);
  assert.deepEqual(exported.nodes[2].public, ARTICLE_BODY.nodes[2].public);
  assert.equal(exported.nodes[2].kind, 'action');
});

test('the record handed in is not mutated — the object store keeps the annotation layer', () => {
  const body = structuredClone(ARTICLE_BODY);
  materialize('content_item', 'req_probe_private_20260901_01', body, META);

  assert.deepEqual(body, ARTICLE_BODY, 'materializing is a read of the record, never a write to it');
  assert.equal(body.nodes[0].private.strategy, 'hook');
});

test('the stripped export still round-trips through the body schema', () => {
  const file = materialize('content_item', 'req_probe_private_20260901_01', ARTICLE_BODY, META);
  const { __generated, ...body } = JSON.parse(file.content) as Record<string, unknown>;

  assert.ok(__generated, 'the generated marker survives the strip');
  const parsed = contentItemBodySchema.safeParse(body);
  assert.ok(parsed.success, `the export must still parse as a content_item body: ${parsed.error?.message}`);
});

test('the strip is not content-item-specific — a page body loses it too', () => {
  const pageBody = {
    route: '/private-strip-probe',
    title: 'A page with an annotated section',
    page_type: 'standard',
    seo: { meta_description: 'A fixture page used to pin the annotation strip across types.' },
    sections: [{ section_id: 'sec_probe_private' }],
  } as unknown as Record<string, unknown>;

  // The page body schema does not carry `private` today; the guarantee is that
  // renderExport drops it wherever it appears, so a body that grows one later
  // inherits the strip instead of having to remember it.
  const annotated = { ...pageBody, sections: [{ section_id: 'sec_probe_private', private: { strategy: 'hook' } }] };
  let content: string;
  try {
    content = materialize('page', 'page_private_strip_probe', annotated, META).content;
  } catch {
    // A strict page schema rejecting the extra key is an equally good outcome:
    // the annotation cannot reach the export by that route either.
    return;
  }
  assert.deepEqual(findPrivatePaths(JSON.parse(content)), []);
});
