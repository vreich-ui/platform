import { describe, it } from 'node:test';
import assert from 'node:assert';

import { getBlobStoreSourceDiagnostics } from '../../server/lib/blob-store.js';
import { normalizeSiteIdDiagnostic, type StoreDiagnostic } from './maintenance-client.js';

describe('normalizeSiteIdDiagnostic', () => {
  it('accepts the server diagnostic type without a duplicated client declaration', () => {
    const diagnostic: StoreDiagnostic = getBlobStoreSourceDiagnostics('workflows', {});

    assert.deepStrictEqual(normalizeSiteIdDiagnostic(diagnostic.siteId), diagnostic.siteId);
  });

  it('passes through the real server shape ({envVar, present, redacted})', () => {
    assert.deepStrictEqual(normalizeSiteIdDiagnostic({ envVar: 'NETLIFY_SITE_ID', present: true, redacted: '…ab12' }), {
      envVar: 'NETLIFY_SITE_ID',
      present: true,
      redacted: '…ab12',
    });
  });

  it('treats an absent site id (envVar undefined, present false) as unset', () => {
    assert.deepStrictEqual(normalizeSiteIdDiagnostic({ envVar: undefined, present: false, redacted: '' }), {
      envVar: undefined,
      present: false,
      redacted: '',
    });
  });

  it('rejects an envVar outside the known union rather than trusting the payload', () => {
    assert.deepStrictEqual(normalizeSiteIdDiagnostic({ envVar: 'SOME_OTHER_VAR', present: true, redacted: '…zz99' }), {
      envVar: undefined,
      present: true,
      redacted: '…zz99',
    });
  });

  it('narrows a plain string (older server build) to a renderable diagnostic', () => {
    assert.deepStrictEqual(normalizeSiteIdDiagnostic('site-abc123'), {
      envVar: undefined,
      present: true,
      redacted: 'site-abc123',
    });
    assert.deepStrictEqual(normalizeSiteIdDiagnostic(''), { envVar: undefined, present: false, redacted: '' });
  });

  it('degrades null/undefined/other garbage to "not set" instead of throwing', () => {
    assert.deepStrictEqual(normalizeSiteIdDiagnostic(null), { envVar: undefined, present: false, redacted: '' });
    assert.deepStrictEqual(normalizeSiteIdDiagnostic(undefined), { envVar: undefined, present: false, redacted: '' });
    assert.deepStrictEqual(normalizeSiteIdDiagnostic(42), { envVar: undefined, present: false, redacted: '' });
  });
});
