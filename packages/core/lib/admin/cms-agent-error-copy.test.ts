/**
 * Task B (provider-error-details) — the ONE function that decides what a
 * CMS-Agent failure reads as, shared by the admin chat's `run_error` line and
 * the workflow run's "Stopped at …" card. Fixture is the real 2026-08-29
 * incident: OpenAI returned 429 credit_balance_exhausted and it surfaced as
 * "The Publishing Agent service is unavailable" — the generic fallback
 * swallowed detail CMS-Agent had already sent.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CMS_AGENT_UNAVAILABLE_TEXT, cmsAgentErrorCopy, hasOperatorAction, type CmsAgentErrorDetail } from './cms-agent-error-copy.js';

const PROVIDER_QUOTA: CmsAgentErrorDetail = {
  code: 'provider_quota',
  message: 'Node "article_body" received 429 from openai: Your credit balance is too low.',
  operatorAction: "Top up openai credit for this project's key, then workflow.retry_node article_body.",
  providerStatus: 429,
  providerMessage: 'Your credit balance is too low',
  fromJsonBody: true,
};

describe('cmsAgentErrorCopy — case 1: no JSON body gets the generic sentence', () => {
  it('a connect error / timeout / unparseable body (fromJsonBody absent) never leaks raw detail', () => {
    const copy = cmsAgentErrorCopy({ code: 'cms_agent_unreachable', message: 'ECONNREFUSED' });
    assert.equal(copy.text, CMS_AGENT_UNAVAILABLE_TEXT);
    assert.equal(copy.providerDetail, undefined);
  });

  it('an HTML 5xx body — explicitly false, not just absent — is the same "no body" case', () => {
    const copy = cmsAgentErrorCopy({ code: 'cms_agent_error', message: '<html>502 Bad Gateway</html>', fromJsonBody: false });
    assert.equal(copy.text, CMS_AGENT_UNAVAILABLE_TEXT);
  });

  it('operatorAction alone does not unlock detail without fromJsonBody', () => {
    // Defensive: a caller must explicitly assert a real JSON body was parsed.
    const copy = cmsAgentErrorCopy({ code: 'cms_agent_error', message: 'x', operatorAction: 'do something' });
    assert.equal(copy.text, CMS_AGENT_UNAVAILABLE_TEXT);
  });
});

describe('cmsAgentErrorCopy — case 2: a JSON body with a code renders "<code>: <message> — <operatorAction>"', () => {
  it('renders the real detail for the incident fixture', () => {
    const copy = cmsAgentErrorCopy(PROVIDER_QUOTA);
    assert.equal(
      copy.text,
      'provider_quota: Node "article_body" received 429 from openai: Your credit balance is too low. — ' +
        "Top up openai credit for this project's key, then workflow.retry_node article_body."
    );
  });

  it('omits the " — <operatorAction>" suffix entirely when there is none to show', () => {
    const copy = cmsAgentErrorCopy({ code: 'model_error', message: 'boom', fromJsonBody: true });
    assert.equal(copy.text, 'model_error: boom');
  });

  it('never returns the generic sentence once fromJsonBody is true, whatever the code', () => {
    const copy = cmsAgentErrorCopy({ code: 'some_code_platform_has_never_seen', message: 'detail', fromJsonBody: true });
    assert.notEqual(copy.text, CMS_AGENT_UNAVAILABLE_TEXT);
    assert.equal(copy.text, 'some_code_platform_has_never_seen: detail');
  });

  it('a crafted PF3 sentence (e.g. cms_agent_not_configured) always wins, JSON body or not', () => {
    const withBody = cmsAgentErrorCopy({ code: 'cms_agent_not_configured', message: 'raw text', fromJsonBody: true });
    const withoutBody = cmsAgentErrorCopy({ code: 'cms_agent_not_configured', message: 'raw text' });
    assert.equal(withBody.text, withoutBody.text);
    assert.match(withBody.text, /not configured for this site/);
  });
});

describe('cmsAgentErrorCopy — cases 3+4: the provider detail line is Owner-only', () => {
  it('an Owner sees "provider <status>: <message>"', () => {
    const copy = cmsAgentErrorCopy(PROVIDER_QUOTA, { isOwner: true });
    assert.equal(copy.providerDetail, 'provider 429: Your credit balance is too low');
  });

  it('an editor sees no provider line at all', () => {
    const copy = cmsAgentErrorCopy(PROVIDER_QUOTA, { isOwner: false });
    assert.equal(copy.providerDetail, undefined);
  });

  it('defaults to editor (isOwner false) when the caller omits the option entirely', () => {
    const copy = cmsAgentErrorCopy(PROVIDER_QUOTA);
    assert.equal(copy.providerDetail, undefined);
  });

  it('an Owner still sees no provider line when there is nothing to show', () => {
    const copy = cmsAgentErrorCopy({ code: 'model_error', message: 'boom', fromJsonBody: true }, { isOwner: true });
    assert.equal(copy.providerDetail, undefined);
  });
});

describe('hasOperatorAction', () => {
  it('is true for a non-blank operatorAction', () => {
    assert.equal(hasOperatorAction({ operatorAction: 'Wait and retry.' }), true);
  });
  it('is false for absent or blank operatorAction', () => {
    assert.equal(hasOperatorAction({}), false);
    assert.equal(hasOperatorAction({ operatorAction: '' }), false);
    assert.equal(hasOperatorAction({ operatorAction: '   ' }), false);
  });
});
