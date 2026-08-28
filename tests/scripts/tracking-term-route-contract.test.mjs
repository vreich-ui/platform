import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const routes = [
  ...['drlurie', 'fernwell', 'platform', 'zilberman'].flatMap((site) => [
    {
      label: `${site} category`,
      file: `sites/${site}/app/pages/[...blog]/[category]/[...page].astro`,
      resolver: "resolveRouteTermId('category', category.slug)",
      binding: 'categoryTermId',
    },
    {
      label: `${site} tag`,
      file: `sites/${site}/app/pages/[...blog]/[tag]/[...page].astro`,
      resolver: "resolveRouteTermId('tag', tag.slug)",
      binding: 'tagTermId',
    },
  ]),
  {
    label: 'drlurie topic detail',
    file: 'sites/drlurie/app/pages/learn/topics/[topicSlug].astro',
    resolver: "resolveRouteTermId('category', topic.slug)",
    binding: 'topicTermId',
  },
];

for (const route of routes) {
  test(`${route.label} resolves and stamps its stable taxonomy id`, () => {
    const source = fs.readFileSync(path.join(repoRoot, route.file), 'utf8');
    assert.ok(source.includes(`await ${route.resolver}`), `${route.file} must resolve the stored taxonomy id`);
    assert.match(
      source,
      new RegExp(`<section\\b[^>]*\\bdata-cms-term-id=\\{${route.binding}\\}[^>]*>`, 's'),
      `${route.file} must stamp the resolved id on its existing route wrapper`
    );
  });
}
