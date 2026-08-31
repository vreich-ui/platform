import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGemInstructions, renderGemInstructions } from '../../packages/core/server/lib/plugin/export-gemini.js';
import { buildManifestBundle } from '../../packages/core/server/lib/plugin/build-manifest.js';
import { visibleToolDefinitions } from '../../netlify/functions/mcp.js';

const bundle = buildManifestBundle({
  origin: 'https://drluriescience.netlify.app',
  definitions: visibleToolDefinitions(),
  voice: {
    object_id: 'voice_drlurie',
    record_version: 14,
    body: { name: 'Dr. Lurie — evidence-led skin health', lexicon: { prefer: ['barrier'], avoid: ['miracle'] } },
  },
  platform: 'gemini',
  now: () => new Date('2026-08-31T12:00:00.000Z'),
  approval: { master: 'all-autonomous' },
});

test('the Gem says plainly that it cannot publish', () => {
  const gem = renderGemInstructions(bundle);
  // The failure mode of a half-capable export is a model that claims to have
  // published and has not. Say it in the first paragraph, not a footnote.
  assert.match(gem, /\*\*You cannot publish\.\*\*/);
  assert.match(gem, /do not claim otherwise/);
  assert.match(gem, /do not invent a URL/);
  assert.ok(gem.indexOf('You cannot publish') < 600, 'the limitation must be near the top');
});

test('the Gem carries the voice and the ceiling it must respect', () => {
  const gem = renderGemInstructions(bundle);
  assert.ok(gem.includes('miracle'), 'the avoid-lexicon must survive');
  assert.match(gem, /claim_strength 0\.45/);
  assert.match(gem, /\*\*ceiling, not a\s+target\*\*/);
});

test('the method section appears exactly once — the voice slice must not swallow it', () => {
  // sliceBetween('## 1. Voice', '## 3. Drafting') would include the skill's own
  // Method section, which this export then writes again in its own words.
  const gem = renderGemInstructions(bundle);
  const occurrences = gem.split('ceiling, not a target').length - 1;
  assert.equal(occurrences, 1, 'the ceiling explanation is duplicated');
  assert.equal(gem.split('## Method').length - 1, 1);
});

test("sliced headings lose the skill's numbering so the outline reads straight", () => {
  const gem = renderGemInstructions(bundle);
  assert.ok(!/^## \d+\. /m.test(gem), 'a numbered heading leaked in from the skill');
  assert.match(gem, /^## Voice$/m);
  assert.match(gem, /^## Drafting/m);
});

test('the Gem names a complete handover payload', () => {
  const gem = renderGemInstructions(bundle);
  for (const item of ['slug', 'deck', 'meta description', 'hero image', 'Sources block']) {
    assert.ok(gem.includes(item), `handover list is missing ${item}`);
  }
  assert.match(gem, /subject only/);
});

test('the Gem repeats the two rules that bite downstream', () => {
  const gem = renderGemInstructions(bundle);
  assert.match(gem, /Sources, never a claims list/);
  assert.match(gem, /Never write the voice/);
});

test('the Gem export is a single markdown file — a Gem has one field', () => {
  const gem = buildGemInstructions(bundle);
  assert.equal(gem.filename, 'dr-lurie-gem-instructions.md');
  assert.ok(gem.content.includes(bundle.manifest_version));
  assert.ok(!gem.content.includes('create_agent_artifact_job'), 'no tool procedure belongs in a toolless surface');
});
