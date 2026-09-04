import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/plugin-install.js';
import { handler as manifestHandler } from '../../netlify/functions/admin-plugin-manifest.js';
import { handler as pluginActionsHandler } from '../../netlify/functions/plugin-actions.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { INSTALL_ERRORS, installCards, type InstallFacts } from '../../packages/core/lib/plugin-install.js';
import { buildInstallFacts } from '../../packages/core/server/functions/plugin-install.js';

/**
 * W7.1 acceptance — the public install page's endpoint.
 *
 * Three properties, each one a way this page could quietly become useless:
 *
 *  1. IT RENDERS WITH NO SESSION. The reader arrives from an invitation and
 *     often has no account yet. A page that 401s before it explains itself is
 *     how an install stalls, and it is the reason this endpoint exists beside
 *     the Owner-only admin one.
 *  2. THE BUNDLES ARE MEMBER-GATED, WITH THREE DISTINGUISHABLE REFUSALS. "Sign
 *     in", "you are read-only" and "this tenant has published nothing" are
 *     three different problems that used to be one 403.
 *  3. THE QUOTED ERROR TEXT IS REAL. Each card carries the literal string the
 *     server emits, so an installer can match their screen against the page.
 *     The moment one drifts, the page starts lying — which is worse than
 *     silence, because the installer stops trusting it. The last test drives
 *     the real façade to prove the charter refusal still reads as quoted.
 */
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
process.env.ADMIN_EMAILS = 'owner@example.com';
process.env.ROLE_EMAILS_EDITOR = 'editor@example.com';
process.env.ROLE_EMAILS_ADMIN = '';
process.env.ROLE_EMAILS_PUBLISHER = '';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'plugin-install-endpoint');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

const HEADERS = { host: 'drluriescience.netlify.app', 'x-forwarded-proto': 'https' };
const asUser = (email: string, sub: string) => ({ clientContext: { user: { sub, email } } });
const OWNER = asUser('owner@example.com', 'usr_owner');
const EDITOR = asUser('editor@example.com', 'usr_editor');
const READER = asUser('reader@example.com', 'usr_reader');

const parseBody = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

const promoteABundle = async () => {
  const rendered = await manifestHandler(
    { httpMethod: 'POST', headers: HEADERS, body: JSON.stringify({ action: 'render', platform: 'openai' }) },
    OWNER
  );
  assert.equal(parseBody(rendered).ok, true, rendered.body);
  const promoted = await manifestHandler(
    { httpMethod: 'POST', headers: HEADERS, body: JSON.stringify({ action: 'promote' }) },
    OWNER
  );
  assert.equal(parseBody(promoted).ok, true, promoted.body);
};

// ─── the cards, as content ───────────────────────────────────────────────────

const FACTS: InstallFacts = buildInstallFacts({
  origin: 'https://drluriescience.netlify.app',
  brandName: 'Dr. Lurié Skincare',
  tenant: 'dr-lurie',
  manifestVersion: 'dr-lurie-openai-20260904-abcdef01',
  toolsDigest: 'sha_abcdef01_49',
});

test('every card stops at three steps — a page nobody finishes is worth nothing', () => {
  for (const card of installCards(FACTS)) {
    assert.ok(card.steps.length <= 3, `${card.id} has ${card.steps.length} steps`);
    assert.ok(card.steps.length >= 1, `${card.id} has no steps`);
  }
});

test('every card ends on "prove it", and that means whoami', () => {
  for (const card of installCards(FACTS)) {
    if (card.id === 'gemini') {
      // A Gem holds no credential and reaches nothing — there is nothing to
      // prove, and the card says exactly that rather than inventing a step.
      assert.match(card.prove.do, /nothing to prove/i);
      continue;
    }
    assert.match(card.prove.do, /whoami/, `${card.id} does not end on whoami`);
    assert.match(card.prove.do, /can_write/, `${card.id} does not tell the installer what to check`);
  }
});

test('the URLs on the cards are the ones the tenant serves, never typed by hand', () => {
  const cards = installCards(FACTS);
  const copied = cards.flatMap((card) => card.steps.map((step) => step.copy).filter(Boolean));
  assert.ok(copied.includes(FACTS.mcp_url), 'the Claude/Agent cards must offer the real MCP URL');
  assert.ok(copied.includes(FACTS.openapi_url), 'the GPT card must offer the real Actions schema URL');
  // Every download points at this endpoint, not at the Owner-only admin one —
  // an editor following an admin export URL gets a 403 they cannot act on.
  for (const card of cards) {
    for (const step of card.steps) {
      if (step.download) assert.match(step.download.href, /^\/api\/plugin-install\?download=/);
    }
  }
});

test('a published Custom GPT link replaces the build-it-yourself step when the site declares one', () => {
  const withLink = installCards({ ...FACTS, custom_gpt_url: 'https://chatgpt.com/g/g-example' });
  const gpt = withLink.find((card) => card.id === 'openai-gpt');
  assert.equal(gpt?.steps[0].link?.href, 'https://chatgpt.com/g/g-example');
  // …and without one, the card still works: it says build it from the schema.
  const without = installCards(FACTS).find((card) => card.id === 'openai-gpt');
  assert.equal(without?.steps[0].link, undefined);
  assert.equal(without?.steps[0].copy, FACTS.openapi_url);
});

// ─── the endpoint ────────────────────────────────────────────────────────────

test('with nothing promoted, the page loads and says so — it never 404s or 401s', async () => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });

  const response = await handler({ httpMethod: 'GET', headers: HEADERS });
  assert.equal(response.statusCode, 200, response.body);
  const body = parseBody(response);
  assert.equal(body.ready, false);
  assert.equal(body.facts, null);
});

test('once a bundle is promoted, the facts and cards come back to an ANONYMOUS caller', async (t) => {
  await promoteABundle();

  const response = await handler({ httpMethod: 'GET', headers: HEADERS });
  assert.equal(response.statusCode, 200, response.body);
  const body = parseBody(response) as unknown as { ready: boolean; facts: InstallFacts; cards: unknown[] };

  await t.test('no session was needed', () => {
    assert.equal(body.ready, true);
    assert.ok(Array.isArray(body.cards) && body.cards.length >= 3);
  });

  await t.test('the origin is the one the request arrived on, not a stored one', () => {
    assert.equal(body.facts.origin, 'https://drluriescience.netlify.app');
    assert.equal(body.facts.mcp_url, 'https://drluriescience.netlify.app/mcp');
    assert.equal(body.facts.openapi_url, 'https://drluriescience.netlify.app/api/plugin/openapi.json');
  });

  await t.test('the version and digest an installer compares against are present', () => {
    assert.match(body.facts.manifest_version, /^dr-lurie-/);
    assert.match(body.facts.tools_digest, /^sha_/);
  });
});

test('a download refuses an anonymous caller — and says to sign in, not "forbidden"', async () => {
  const response = await handler({ httpMethod: 'GET', headers: HEADERS, queryStringParameters: { download: 'skill' } });
  assert.equal(response.statusCode, 401);
  assert.equal(parseBody(response).error_code, 'install_requires_member');
});

test('a signed-in reader with no editing role is told exactly that', async () => {
  const response = await handler(
    { httpMethod: 'GET', headers: HEADERS, queryStringParameters: { download: 'skill' } },
    READER
  );
  assert.equal(response.statusCode, 403);
  assert.equal(parseBody(response).error_code, 'install_requires_editor');
});

test('an EDITOR — not an admin — can download the bundle they were invited to install', async (t) => {
  const skill = await handler(
    { httpMethod: 'GET', headers: HEADERS, queryStringParameters: { download: 'skill' } },
    EDITOR
  );
  assert.equal(skill.statusCode, 200, skill.body);
  const zip = skill as { headers?: Record<string, string>; isBase64Encoded?: boolean };
  assert.equal(zip.headers?.['Content-Type'], 'application/zip');
  assert.equal(zip.isBase64Encoded, true, 'zip bytes must travel base64-encoded');

  await t.test('the filename carries the manifest version, so an install can be dated', () => {
    assert.match(String(zip.headers?.['Content-Disposition']), /filename="/);
    assert.ok(zip.headers?.['X-Plugin-Manifest-Version']);
  });

  await t.test('the Gem instructions come back as markdown, not a zip', async () => {
    const gem = await handler(
      { httpMethod: 'GET', headers: HEADERS, queryStringParameters: { download: 'gemini' } },
      EDITOR
    );
    assert.equal(gem.statusCode, 200, gem.body);
    assert.match(String((gem as { headers?: Record<string, string> }).headers?.['Content-Type']), /text\/markdown/);
  });
});

test('an unknown download kind is refused before anything is read', async () => {
  const response = await handler(
    { httpMethod: 'GET', headers: HEADERS, queryStringParameters: { download: 'everything' } },
    EDITOR
  );
  assert.equal(response.statusCode, 400);
});

// ─── the quoted error text is the real error text ────────────────────────────

test('the charter refusal the GPT card quotes is the one the façade actually emits', async () => {
  const response = await pluginActionsHandler({
    httpMethod: 'POST',
    path: '/api/plugin/wipe_blob_stores',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.statusCode, 403, response.body);
  const message = String(parseBody(response).error);
  assert.ok(
    message.includes(INSTALL_ERRORS.notInCharter.text),
    `the install page quotes "${INSTALL_ERRORS.notInCharter.text}" but the façade says "${message}"`
  );

  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
});
