import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isObjectIdWithinCeiling,
  isSectionInstanceId,
  OBJECT_ID_MAX_LENGTH,
  siteShortId,
  validateObjectIdForType,
  validateSectionInstanceId,
  type ObjectIdValidationResult,
} from './object-ids.js';
import { validateRequestId } from './agents-naming.js';
import type { ObjectType } from '../schema/object-record-v1.js';

const expectValid = (result: ObjectIdValidationResult, value: string) => {
  assert.deepStrictEqual(result, { ok: true, value });
};

const validObjectIds: Array<[ObjectType, string]> = [
  ['site', 'site_drlurie'],
  ['page', 'page_home'],
  ['section', 'sec_newsletter_signup'],
  ['navigation', 'nav_footer_home'],
  ['taxonomy', 'tax_drlurie'],
  ['template', 'tpl_home'],
  ['product', 'prod_barrier_repair_guide'],
  ['content_item', 'req_smoke_pdf_cta_20260630_01'],
];

const invalidObjectIds: Array<[ObjectType, string]> = [
  ['site', 'page_home'],
  ['page', 'page-Home'],
  ['section', 's_hero'],
  ['navigation', 'nav_'],
  ['taxonomy', 'tax_drlurie!'],
  ['template', 'template_home'],
  ['product', 'product_guide'],
  ['content_item', 'req_foo'],
];

describe('object ID validators', () => {
  it('checks the D§3.1 ceiling regex', () => {
    assert.strictEqual(isObjectIdWithinCeiling('page_home'), true);
    assert.strictEqual(isObjectIdWithinCeiling('req_smoke_pdf_cta_20260630_01'), true);
    assert.strictEqual(isObjectIdWithinCeiling('s_hero'), false);
    assert.strictEqual(isObjectIdWithinCeiling('page-home'), false);
  });

  it('accepts valid IDs for every object type', () => {
    for (const [objectType, value] of validObjectIds) {
      assert.strictEqual(validateObjectIdForType(objectType, value).ok, true, `${objectType}:${value}`);
    }
  });

  it('rejects malformed IDs for every object type', () => {
    for (const [objectType, value] of invalidObjectIds) {
      assert.strictEqual(validateObjectIdForType(objectType, value).ok, false, `${objectType}:${value}`);
    }
  });

  it('delegates content_item validation to validateRequestId verbatim', () => {
    const knownBad = 'req_foo';
    const valid = 'req_smoke_pdf_cta_20260630_01';

    assert.deepStrictEqual(validateObjectIdForType('content_item', knownBad), validateRequestId(knownBad));
    assert.deepStrictEqual(validateObjectIdForType('content_item', valid), validateRequestId(valid));
  });

  // An object id becomes a blob-store key. Before this bound, an over-long id
  // reached the store and came back as an opaque provider error — the 2026-09
  // incident, where a several-hundred-character minted id surfaced in a user's
  // chat as "Netlify Blobs has generated an internal error (400 status code,
  // ID: cb90450d-…)" and nothing else.
  it('refuses an over-long id for every type, with a readable error naming the length', () => {
    const longSuffix = 'a_'.repeat(OBJECT_ID_MAX_LENGTH).slice(0, OBJECT_ID_MAX_LENGTH);
    for (const [objectType] of validObjectIds) {
      const tooLong = `${objectType === 'content_item' ? 'req' : 'page'}_${longSuffix}`;
      assert.ok(tooLong.length > OBJECT_ID_MAX_LENGTH);
      const result = validateObjectIdForType(objectType, tooLong);
      assert.strictEqual(result.ok, false, objectType);
      assert.match(result.ok ? '' : result.error, new RegExp(String(OBJECT_ID_MAX_LENGTH)));
      assert.match(result.ok ? '' : result.error, /blob-store key|requested_id/);
    }
  });

  it('leaves every id the fleet actually mints comfortably inside the bound', () => {
    // The longest live id in the repo today is a 70-character
    // req_agent_<topic>_<yyyymmdd>_01, so the bound is a backstop, not a
    // constraint anyone writing an ordinary id can feel.
    for (const [objectType, value] of validObjectIds) {
      assert.ok(value.length <= OBJECT_ID_MAX_LENGTH, `${objectType}:${value}`);
      assert.strictEqual(validateObjectIdForType(objectType, value).ok, true);
    }
    assert.strictEqual(
      validateObjectIdForType('page', `page_${'a'.repeat(OBJECT_ID_MAX_LENGTH - 5)}`).ok,
      true,
      'exactly at the bound is still valid'
    );
  });

  it('siteShortId strips the site_ prefix and is a no-op on a bare slug', () => {
    assert.strictEqual(siteShortId('site_drlurie'), 'drlurie');
    assert.strictEqual(siteShortId('drlurie'), 'drlurie');
  });

  it('validates section-instance IDs with no underscores inside the suffix', () => {
    expectValid(validateSectionInstanceId('s_hero'), 's_hero');
    assert.strictEqual(isSectionInstanceId('s_startgrid'), true);
    assert.strictEqual(validateSectionInstanceId('s_start_grid').ok, false);
    assert.strictEqual(validateSectionInstanceId('sec_newsletter_signup').ok, false);
  });
});
