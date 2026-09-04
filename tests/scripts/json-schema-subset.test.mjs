/**
 * T2.7 — tests for `scripts/lib/json-schema-subset.mjs`, the hand-rolled
 * validator for the JSON Schema keyword subset pdf-tool's chromium
 * templates use in `renderDataSchema`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateAgainstSchema } from '../../scripts/lib/json-schema-subset.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTICLE_BROCHURE_V1 = JSON.parse(
  readFileSync(path.join(here, '..', '..', 'scripts', 'lib', 'pdf-templates', 'article_brochure_v1.json'), 'utf8')
);

test('validates a minimal object schema with required + additionalProperties:false', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: 'string', minLength: 1 } },
  };
  assert.equal(validateAgainstSchema(schema, { a: 'x' }).valid, true);
  assert.equal(validateAgainstSchema(schema, {}).valid, false);
  assert.deepEqual(validateAgainstSchema(schema, {}).errors, [`$: missing required property 'a'`]);
  const extra = validateAgainstSchema(schema, { a: 'x', b: 1 });
  assert.equal(extra.valid, false);
  assert.deepEqual(extra.errors, [`$: unexpected property 'b'`]);
});

test('resolves $ref against $defs', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { $ref: '#/$defs/assetId' } },
    $defs: { assetId: { type: 'string', pattern: '^[a-z]+$' } },
  };
  assert.equal(validateAgainstSchema(schema, { id: 'abc' }).valid, true);
  assert.equal(validateAgainstSchema(schema, { id: 'ABC' }).valid, false);
  assert.equal(validateAgainstSchema(schema, { id: 123 }).valid, false);
});

test('array minItems/maxItems and per-item validation', () => {
  const schema = { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 1 } };
  assert.equal(validateAgainstSchema(schema, ['a']).valid, true);
  assert.equal(validateAgainstSchema(schema, []).valid, false);
  assert.equal(validateAgainstSchema(schema, ['a', 'b', 'c']).valid, false);
  assert.equal(validateAgainstSchema(schema, ['a', '']).valid, false);
});

test('a Record<string,T> via additionalProperties as a schema', () => {
  const schema = {
    type: 'object',
    minProperties: 1,
    additionalProperties: { type: 'string', minLength: 1, maxLength: 4 },
  };
  assert.equal(validateAgainstSchema(schema, { primary: 'blue' }).valid, true);
  assert.equal(validateAgainstSchema(schema, {}).valid, false, 'minProperties:1 rejects an empty object');
  assert.equal(validateAgainstSchema(schema, { primary: 'toolong' }).valid, false);
});

test('an unsupported keyword is reported, not silently ignored', () => {
  const result = validateAgainstSchema({ type: 'string', oneOf: [{ type: 'string' }] }, 'x');
  assert.equal(result.valid, false);
  assert.equal(result.errors[0], `$: unsupported schema keyword 'oneOf'`);
});

test('the REAL article_brochure_v1 renderDataSchema validates its own unmodified sampleData', () => {
  const result = validateAgainstSchema(ARTICLE_BROCHURE_V1.renderDataSchema, ARTICLE_BROCHURE_V1.sampleData);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('the REAL article_brochure_v1 renderDataSchema rejects sampleData with a missing required field', () => {
  const broken = { ...ARTICLE_BROCHURE_V1.sampleData };
  delete broken.sources;
  const result = validateAgainstSchema(ARTICLE_BROCHURE_V1.renderDataSchema, broken);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("missing required property 'sources'")));
});
