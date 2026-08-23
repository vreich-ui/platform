/**
 * W19 T19.7 — the seam, the adapter, and the promise that unconfigured is
 * NORMAL rather than broken.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isMailConfigured, nullMailSender } from './index.js';
import { resendMailSender } from './resend.js';
import { requestMail, resolveMailSender } from './send.js';

const withEnv = async (env: Record<string, string | undefined>, run: () => Promise<void> | void) => {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const CONFIGURED = { MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'key_test', MAIL_FROM: 'editorial@example.com' };

describe('a tenant with no mail provider', () => {
  it('is a supported state, not a failure', async () => {
    await withEnv({ MAIL_PROVIDER: undefined, MAIL_API_KEY: undefined, MAIL_FROM: undefined }, async () => {
      assert.equal(isMailConfigured(), false);
      assert.equal(resolveMailSender().provider, 'none');
      const result = await nullMailSender.send({ to: 'a@b.com', subject: 's', text: 't' });
      assert.equal(result.ok, false);
      // The catalogued code W16 law P2 requires for a degrade.
      assert.equal(result.ok === false && result.code, 'mail_not_configured');
      assert.match(result.ok === false ? result.message : '', /in-app and browser channels are unaffected/);
    });
  });

  it('treats an explicit `none` the same as unset', async () => {
    await withEnv({ ...CONFIGURED, MAIL_PROVIDER: 'none' }, () => {
      assert.equal(isMailConfigured(), false);
      assert.equal(resolveMailSender().provider, 'none');
    });
  });

  it('refuses to call itself configured on half a configuration', async () => {
    await withEnv({ ...CONFIGURED, MAIL_FROM: undefined }, () => assert.equal(isMailConfigured(), false));
    await withEnv({ ...CONFIGURED, MAIL_API_KEY: undefined }, () => assert.equal(isMailConfigured(), false));
  });
});

describe('the adapter', () => {
  it('sends one bounded request and returns the provider id', async () => {
    await withEnv(CONFIGURED, async () => {
      let seen: { url: string; body: Record<string, unknown> } | undefined;
      const fetchImpl = (async (url: string, init: RequestInit) => {
        seen = { url: String(url), body: JSON.parse(String(init.body)) };
        return new Response(JSON.stringify({ id: 'mail_123' }), { status: 200 });
      }) as unknown as typeof fetch;

      const result = await resendMailSender(fetchImpl).send({
        to: 'editor@example.com',
        subject: 'Needs you: Retinol',
        text: 'Waiting for your approval.',
        tags: { kind: 'editorial_request' },
      });
      assert.deepEqual(result, { ok: true, id: 'mail_123' });
      assert.match(seen!.url, /api\.resend\.com/);
      assert.equal(seen!.body.from, 'editorial@example.com');
      assert.deepEqual(seen!.body.to, ['editor@example.com']);
    });
  });

  it('types a refusal and a network failure differently, and never throws', async () => {
    await withEnv(CONFIGURED, async () => {
      const rejecting = (async () => new Response('domain not verified', { status: 403 })) as unknown as typeof fetch;
      const refused = await resendMailSender(rejecting).send({ to: 'a@b.com', subject: 's', text: 't' });
      assert.equal(refused.ok === false && refused.code, 'mail_rejected');
      assert.match(refused.ok === false ? refused.message : '', /domain not verified/);

      const throwing = (async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof fetch;
      const unreachable = await resendMailSender(throwing).send({ to: 'a@b.com', subject: 's', text: 't' });
      assert.equal(unreachable.ok === false && unreachable.code, 'mail_unreachable');
    });
  });

  it('refuses an address that is not one, before spending a request', async () => {
    await withEnv(CONFIGURED, async () => {
      let called = false;
      const fetchImpl = (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;
      const result = await resendMailSender(fetchImpl).send({ to: 'not-an-address', subject: 's', text: 't' });
      assert.equal(result.ok === false && result.code, 'mail_invalid');
      assert.equal(called, false);
    });
  });
});

describe('the message', () => {
  it('says what happened, which request, and one link — and carries no content', () => {
    const mail = requestMail({
      requestId: 'req_agent_retinol_20260822_01',
      title: 'Retinol after 40',
      status: 'needs_you',
      statusReason: 'Publish-risk node requires explicit approval.',
      origin: 'https://example.netlify.app/',
    });
    assert.equal(mail.subject, 'Needs you: Retinol after 40');
    assert.match(mail.text, /requires explicit approval/);
    assert.match(mail.text, /https:\/\/example\.netlify\.app\/admin\/requests\/req_agent_retinol_20260822_01/);
    assert.match(mail.text, /Change or stop these e-mails/);
  });

  it('degrades to the request id when the site has no known origin', () => {
    const mail = requestMail({ requestId: 'req_x_y_20260822_01', title: 'T', status: 'failed' });
    assert.equal(mail.subject, 'Stopped: T');
    assert.match(mail.text, /req_x_y_20260822_01/);
  });
});
