import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseExamplesJobView } from './visual-identity-examples-client.js';

describe('parseExamplesJobView', () => {
  it('parses the snake_case wire shape into the camelCase view', () => {
    const job = parseExamplesJobView({
      examples_status: 'pending',
      contexts: [{ usageContext: 'article_body', status: 'pending' }],
      trigger: 'browser',
      started_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:01.000Z',
    });
    assert.deepEqual(job, {
      status: 'pending',
      contexts: [{ usageContext: 'article_body', status: 'pending' }],
      trigger: 'browser',
      startedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
    });
  });

  it('carries reason and dispatched only when present', () => {
    const job = parseExamplesJobView({
      examples_status: 'failed',
      contexts: [],
      trigger: 'mcp',
      reason: 'no_sample_subjects',
      dispatched: false,
      started_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:01.000Z',
    });
    assert.equal(job?.reason, 'no_sample_subjects');
    assert.equal(job?.dispatched, false);
  });

  it('returns undefined for a missing or malformed field', () => {
    assert.equal(parseExamplesJobView(undefined), undefined);
    assert.equal(parseExamplesJobView(null), undefined);
    assert.equal(parseExamplesJobView('nope'), undefined);
    assert.equal(parseExamplesJobView({}), undefined);
  });
});
