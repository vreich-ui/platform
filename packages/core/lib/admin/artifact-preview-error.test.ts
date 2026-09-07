import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeArtifactPreviewError } from './artifact-preview-error.js';

describe('describeArtifactPreviewError', () => {
  it('a 404 is permanent: no retry control, and it names the real cause', () => {
    const view = describeArtifactPreviewError(404);
    assert.equal(view.canRetry, false);
    assert.match(view.title, /not in the store/i);
    assert.match(view.message, /does not exist/i);
    // The old copy's two lies, gone: it must not claim retries happened, and
    // must not send the editor to debug their connection over a data problem.
    assert.doesNotMatch(view.message, /after automatic retries/i);
    assert.doesNotMatch(view.message, /check your connection/i);
  });

  it('auth failures are permanent and do not offer a retry', () => {
    for (const status of [401, 403]) {
      const view = describeArtifactPreviewError(status);
      assert.equal(view.canRetry, false, `HTTP ${status} must not offer a retry`);
      assert.match(view.message, /authorized/i);
    }
  });

  it("the endpoint's other refusals each get their own honest copy", () => {
    // 409 ambiguous-artifact-bytes and 422 image-validation are real
    // admin-get-blob-image responses (see its jsonResponse calls), not
    // hypotheticals — each is permanent for this blobKey.
    assert.match(describeArtifactPreviewError(409).title, /ambiguous/i);
    assert.equal(describeArtifactPreviewError(409).canRetry, false);
    assert.match(describeArtifactPreviewError(422).message, /validation/i);
    assert.equal(describeArtifactPreviewError(422).canRetry, false);
  });

  it('an unrecognized 4xx is still permanent, and says so without inventing a cause', () => {
    const view = describeArtifactPreviewError(418);
    assert.equal(view.canRetry, false);
    assert.match(view.message, /418/);
  });

  it('server errors and throttling DO offer a retry, and are the only statuses that claim retries ran', () => {
    for (const status of [408, 429, 500, 503]) {
      const view = describeArtifactPreviewError(status);
      assert.equal(view.canRetry, true, `HTTP ${status} is retryable`);
      assert.match(view.message, /automatic retries/i);
    }
  });

  it('a statusless failure (timeout, dropped connection) is described as unknown, and is retryable', () => {
    const view = describeArtifactPreviewError(undefined);
    assert.equal(view.canRetry, true);
    assert.match(view.message, /timed out|connection/i);
  });

  // The join that made the old copy wrong — that `canRetry` must agree with
  // what the loader ACTUALLY does — is asserted against the real
  // `fetchWithRetry` in artifact-preview-loader.test.ts, which already owns
  // the fake-clock harness that driving a retry loop needs.
});
