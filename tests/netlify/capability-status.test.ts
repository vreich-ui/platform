/**
 * T16.5 — unit + integration coverage for the `capability_status` tool and
 * the per-family "is configured" predicates it composes.
 *
 * Two layers:
 *  1. Predicate-level: env fixtures -> expected {configured, missing} for
 *     each family, calling the SAME exported functions the real gated code
 *     paths use (no re-implementation of the env logic here).
 *  2. Tool-level: the tool is internal-only (never in tools/list) but
 *     callable via tools/call, and its response is provably free of anything
 *     secret-shaped even when every credential env var is populated with a
 *     recognizable secret string.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // registers providers — the core import chain resolves site identity at module load
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import {
  CAPABILITY_FAMILIES,
  getCapabilityStatus,
  type CapabilityFamily,
} from '../../packages/core/server/lib/capability-status.js';
import {
  pdfToolBridgeMissingEnvVars,
  isPdfToolBridgeConfigured,
} from '../../packages/core/server/lib/pdf-tool-client.js';
import {
  pdfToolStorageGrantMissingEnvVars,
  isPdfToolStorageGrantConfigured,
} from '../../packages/core/server/lib/pdf-tool-storage-grant.js';
import { commerceMissingEnvVars, isCommerceConfigured } from '../../packages/core/server/lib/stripe-env.js';
import {
  purchaseTokenMissingEnvVars,
  isPurchaseTokenConfigured,
} from '../../packages/core/server/lib/purchase-tokens.js';
import {
  netlifyBuildHookMissingEnvVars,
  netlifyDeployLookupMissingEnvVars,
  isNetlifyBuildHookConfigured,
  isNetlifyDeployLookupConfigured,
} from '../../packages/core/server/lib/netlify-deploys.js';
import {
  gitCommitterMissingEnvVars,
  isGitCommitterConfigured,
} from '../../packages/core/server/lib/object-git-committer.js';
import {
  blobCredentialsMissingEnvVars,
  isBlobCredentialsConfigured,
} from '../../packages/core/server/lib/blob-store.js';
import {
  artifactUploadMissingEnvVars,
  isArtifactUploadConfigured,
} from '../../packages/core/server/lib/artifact-upload.js';

/** Every env var any predicate below reads — snapshotted/restored per test so tests never leak state to each other or the rest of the suite. */
const ALL_TOUCHED_ENV_VARS = [
  'PDF_TOOL_BASE_URL',
  'PDF_TOOL_AGENT_RUN_TOKEN',
  'PDF_TOOL_STORAGE_TOKEN',
  'PDF_TOOL_STORAGE_SITE_ID',
  'STRIPE_MODE',
  // W19 T19.7 — the opt-in mail family.
  'MAIL_PROVIDER',
  'MAIL_API_KEY',
  'MAIL_FROM',
  'MAIL_REPLY_TO',
  'STRIPE_SECRET_KEY',
  'STRIPE_SECRET_KEY_TEST',
  'PURCHASE_TOKEN_SECRET',
  'NETLIFY_BUILD_HOOK_URL',
  'NETLIFY_SITE_ID',
  'SITE_ID',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_BLOBS_TOKEN',
  'GITHUB_CONTENT_TOKEN',
  'GITHUB_REPOSITORY',
  'ARTIFACT_UPLOAD_TOKEN_SECRET',
] as const;

const withEnv = async (
  values: Partial<Record<(typeof ALL_TOUCHED_ENV_VARS)[number], string>>,
  fn: () => Promise<void> | void
) => {
  const previous = Object.fromEntries(ALL_TOUCHED_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of ALL_TOUCHED_ENV_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;

  try {
    await fn();
  } finally {
    for (const name of ALL_TOUCHED_ENV_VARS) {
      const restored = previous[name];
      if (restored === undefined) delete process.env[name];
      else process.env[name] = restored;
    }
  }
};

// ── Predicate-level: env fixtures -> expected booleans + missing-name lists ─

test('pdf_bridge predicate: configured only with both PDF_TOOL_BASE_URL and PDF_TOOL_AGENT_RUN_TOKEN', async () => {
  await withEnv({}, () => {
    assert.equal(isPdfToolBridgeConfigured(), false);
    assert.deepEqual(pdfToolBridgeMissingEnvVars().sort(), ['PDF_TOOL_AGENT_RUN_TOKEN', 'PDF_TOOL_BASE_URL']);
  });
  await withEnv({ PDF_TOOL_BASE_URL: 'https://pdf-tool.example' }, () => {
    assert.equal(isPdfToolBridgeConfigured(), false);
    assert.deepEqual(pdfToolBridgeMissingEnvVars(), ['PDF_TOOL_AGENT_RUN_TOKEN']);
  });
  await withEnv({ PDF_TOOL_BASE_URL: 'https://pdf-tool.example', PDF_TOOL_AGENT_RUN_TOKEN: 'tok' }, () => {
    assert.equal(isPdfToolBridgeConfigured(), true);
    assert.deepEqual(pdfToolBridgeMissingEnvVars(), []);
  });
});

test('pdf_storage_grant predicate: configured only with both PDF_TOOL_STORAGE_TOKEN and PDF_TOOL_STORAGE_SITE_ID', async () => {
  await withEnv({}, () => {
    assert.equal(isPdfToolStorageGrantConfigured(), false);
    assert.deepEqual(pdfToolStorageGrantMissingEnvVars().sort(), [
      'PDF_TOOL_STORAGE_SITE_ID',
      'PDF_TOOL_STORAGE_TOKEN',
    ]);
  });
  await withEnv({ PDF_TOOL_STORAGE_TOKEN: 'tok' }, () => {
    assert.deepEqual(pdfToolStorageGrantMissingEnvVars(), ['PDF_TOOL_STORAGE_SITE_ID']);
  });
  await withEnv({ PDF_TOOL_STORAGE_TOKEN: 'tok', PDF_TOOL_STORAGE_SITE_ID: 'site-1' }, () => {
    assert.equal(isPdfToolStorageGrantConfigured(), true);
    assert.deepEqual(pdfToolStorageGrantMissingEnvVars(), []);
  });
});

test('commerce predicate: reports the ONE key for the active Stripe mode, not both', async () => {
  await withEnv({}, () => {
    // default mode is 'test' (a missing flag must never charge real cards)
    assert.equal(isCommerceConfigured(), false);
    assert.deepEqual(commerceMissingEnvVars(), ['STRIPE_SECRET_KEY_TEST']);
  });
  await withEnv({ STRIPE_SECRET_KEY_TEST: 'sk_test_x' }, () => {
    assert.equal(isCommerceConfigured(), true);
    assert.deepEqual(commerceMissingEnvVars(), []);
  });
  await withEnv({ STRIPE_MODE: 'live' }, () => {
    assert.equal(isCommerceConfigured(), false);
    assert.deepEqual(commerceMissingEnvVars(), ['STRIPE_SECRET_KEY']);
  });
  await withEnv({ STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_SECRET_KEY_TEST: 'sk_test_x' }, () => {
    // live mode configured even though the (irrelevant) test key is also present
    assert.equal(isCommerceConfigured(), true);
    assert.deepEqual(commerceMissingEnvVars(), []);
  });
});

test('purchase_token predicate: configured only with a 16+ char PURCHASE_TOKEN_SECRET', async () => {
  await withEnv({}, () => {
    assert.equal(isPurchaseTokenConfigured(), false);
    assert.deepEqual(purchaseTokenMissingEnvVars(), ['PURCHASE_TOKEN_SECRET']);
  });
  await withEnv({ PURCHASE_TOKEN_SECRET: 'short' }, () => {
    // purchaseTokenSecret() requires >=16 chars — a too-short value is still "missing"
    assert.equal(isPurchaseTokenConfigured(), false);
    assert.deepEqual(purchaseTokenMissingEnvVars(), ['PURCHASE_TOKEN_SECRET']);
  });
  await withEnv({ PURCHASE_TOKEN_SECRET: 'a-sufficiently-long-secret-value' }, () => {
    assert.equal(isPurchaseTokenConfigured(), true);
    assert.deepEqual(purchaseTokenMissingEnvVars(), []);
  });
});

test('build_hook predicate: configured only with NETLIFY_BUILD_HOOK_URL', async () => {
  await withEnv({}, () => {
    assert.equal(isNetlifyBuildHookConfigured(), false);
    assert.deepEqual(netlifyBuildHookMissingEnvVars(), ['NETLIFY_BUILD_HOOK_URL']);
  });
  await withEnv({ NETLIFY_BUILD_HOOK_URL: 'https://api.netlify.com/hooks/abc' }, () => {
    assert.equal(isNetlifyBuildHookConfigured(), true);
    assert.deepEqual(netlifyBuildHookMissingEnvVars(), []);
  });
});

test('deploy_lookup predicate: configured only with NETLIFY_SITE_ID and a deploy-lookup token', async () => {
  await withEnv({}, () => {
    assert.equal(isNetlifyDeployLookupConfigured(), false);
    assert.deepEqual(netlifyDeployLookupMissingEnvVars().sort(), ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID']);
  });
  await withEnv({ NETLIFY_SITE_ID: 'site-1' }, () => {
    assert.deepEqual(netlifyDeployLookupMissingEnvVars(), ['NETLIFY_AUTH_TOKEN']);
  });
  await withEnv({ NETLIFY_SITE_ID: 'site-1', NETLIFY_AUTH_TOKEN: 'tok' }, () => {
    assert.equal(isNetlifyDeployLookupConfigured(), true);
    assert.deepEqual(netlifyDeployLookupMissingEnvVars(), []);
  });
  // the platform-injected alias (SITE_ID) also satisfies the blobSiteId half
  await withEnv({ SITE_ID: 'site-1', NETLIFY_BLOBS_TOKEN: 'tok' }, () => {
    assert.equal(isNetlifyDeployLookupConfigured(), true);
  });
});

test('git_committer predicate: configured only with GITHUB_CONTENT_TOKEN and GITHUB_REPOSITORY', async () => {
  await withEnv({}, () => {
    assert.equal(isGitCommitterConfigured(), false);
    assert.deepEqual(gitCommitterMissingEnvVars().sort(), ['GITHUB_CONTENT_TOKEN', 'GITHUB_REPOSITORY']);
  });
  await withEnv({ GITHUB_CONTENT_TOKEN: 'ghp_x' }, () => {
    assert.deepEqual(gitCommitterMissingEnvVars(), ['GITHUB_REPOSITORY']);
  });
  await withEnv({ GITHUB_CONTENT_TOKEN: 'ghp_x', GITHUB_REPOSITORY: 'acct/repo' }, () => {
    assert.equal(isGitCommitterConfigured(), true);
    assert.deepEqual(gitCommitterMissingEnvVars(), []);
  });
});

test('blob_credentials predicate: configured only with an explicit site id + token pair', async () => {
  await withEnv({}, () => {
    assert.equal(isBlobCredentialsConfigured(), false);
    assert.deepEqual(blobCredentialsMissingEnvVars().sort(), ['NETLIFY_BLOBS_TOKEN', 'NETLIFY_SITE_ID']);
  });
  await withEnv({ NETLIFY_SITE_ID: 'site-1', NETLIFY_BLOBS_TOKEN: 'tok' }, () => {
    assert.equal(isBlobCredentialsConfigured(), true);
    assert.deepEqual(blobCredentialsMissingEnvVars(), []);
  });
});

test('artifact_upload predicate: configured only with ARTIFACT_UPLOAD_TOKEN_SECRET', async () => {
  await withEnv({}, () => {
    assert.equal(isArtifactUploadConfigured(), false);
    assert.deepEqual(artifactUploadMissingEnvVars(), ['ARTIFACT_UPLOAD_TOKEN_SECRET']);
  });
  await withEnv({ ARTIFACT_UPLOAD_TOKEN_SECRET: 'sig-secret' }, () => {
    assert.equal(isArtifactUploadConfigured(), true);
    assert.deepEqual(artifactUploadMissingEnvVars(), []);
  });
});

// ── getCapabilityStatus(): the composed report ──────────────────────────────

test('getCapabilityStatus reports every family, none configured, with every var missing (except the two that cannot be)', async () => {
  await withEnv({}, () => {
    const report = getCapabilityStatus();
    assert.equal(typeof report.site_id, 'string');
    assert.ok(report.site_id.length > 0);
    assert.deepEqual(Object.keys(report.families).sort(), [...CAPABILITY_FAMILIES].sort());

    for (const family of CAPABILITY_FAMILIES as readonly CapabilityFamily[]) {
      const entry = report.families[family];
      if (family === 'mail') {
        // W19 T19.7: mail is OPT-IN. An empty env means the tenant did not ask
        // for it — not configured, and nothing missing, because nothing was
        // required. Missing vars appear only once MAIL_PROVIDER names one.
        assert.equal(entry.configured, false);
        assert.deepEqual(entry.missing, [], 'an opted-out tenant has no gap to report');
        continue;
      }
      if (family === 'mcp_auth') {
        // trivially true: capability_status itself already cleared the MCP auth gate
        assert.equal(entry.configured, true);
        assert.deepEqual(entry.missing, []);
        continue;
      }
      assert.equal(entry.configured, false, `expected ${family} to be unconfigured`);
      assert.ok(entry.missing.length > 0, `expected ${family} to list at least one missing var`);
    }
  });
});

test('getCapabilityStatus reports every family configured when every required var is set', async () => {
  await withEnv(
    {
      MAIL_PROVIDER: 'resend',
      MAIL_API_KEY: 'mail_key',
      MAIL_FROM: 'editorial@example.com',
      PDF_TOOL_BASE_URL: 'https://pdf-tool.example',
      PDF_TOOL_AGENT_RUN_TOKEN: 'tok',
      PDF_TOOL_STORAGE_TOKEN: 'tok',
      PDF_TOOL_STORAGE_SITE_ID: 'site-1',
      STRIPE_SECRET_KEY_TEST: 'sk_test_x',
      PURCHASE_TOKEN_SECRET: 'a-sufficiently-long-secret-value',
      NETLIFY_BUILD_HOOK_URL: 'https://api.netlify.com/hooks/abc',
      NETLIFY_SITE_ID: 'site-1',
      NETLIFY_AUTH_TOKEN: 'tok',
      GITHUB_CONTENT_TOKEN: 'ghp_x',
      GITHUB_REPOSITORY: 'acct/repo',
      ARTIFACT_UPLOAD_TOKEN_SECRET: 'sig-secret',
    },
    () => {
      const report = getCapabilityStatus();
      for (const family of CAPABILITY_FAMILIES as readonly CapabilityFamily[]) {
        const entry = report.families[family];
        assert.equal(entry.configured, true, `expected ${family} to be configured`);
        assert.deepEqual(entry.missing, []);
      }
    }
  );
});

// ── Tool-level: internal-only, callable, never leaks secret-shaped data ────

const callCapabilityStatus = async () => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'capability_status', arguments: {} },
    }),
  });
  const body = JSON.parse(response.body) as {
    result: { isError?: boolean; structuredContent: Record<string, unknown> };
  };
  return body.result;
};

test('capability_status is callable but never advertised in tools/list', async () => {
  const listResponse = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const listBody = JSON.parse(listResponse.body) as { result: { tools: Array<{ name: string }> } };
  assert.ok(
    !listBody.result.tools.some((tool) => tool.name === 'capability_status'),
    'capability_status must be internal-only (INTERNAL_ONLY_TOOLS), not advertised in tools/list'
  );

  const result = await callCapabilityStatus();
  assert.notEqual(result.isError, true);
  assert.deepEqual(Object.keys(result.structuredContent).sort(), ['families', 'site_id']);
});

test('capability_status never returns anything secret-shaped, even with real-looking credentials set', async () => {
  await withEnv(
    {
      PDF_TOOL_BASE_URL: 'https://pdf-tool.example',
      PDF_TOOL_AGENT_RUN_TOKEN: 'SUPER_SECRET_PDF_TOOL_TOKEN',
      PDF_TOOL_STORAGE_TOKEN: 'SUPER_SECRET_STORAGE_TOKEN',
      PDF_TOOL_STORAGE_SITE_ID: 'site-1',
      STRIPE_SECRET_KEY_TEST: 'sk_test_SUPER_SECRET',
      PURCHASE_TOKEN_SECRET: 'SUPER_SECRET_PURCHASE_TOKEN_VALUE',
      NETLIFY_BUILD_HOOK_URL: 'https://api.netlify.com/hooks/SUPER_SECRET_HOOK',
      NETLIFY_SITE_ID: 'site-1',
      NETLIFY_AUTH_TOKEN: 'SUPER_SECRET_NETLIFY_TOKEN',
      GITHUB_CONTENT_TOKEN: 'ghp_SUPER_SECRET',
      GITHUB_REPOSITORY: 'acct/repo',
      ARTIFACT_UPLOAD_TOKEN_SECRET: 'SUPER_SECRET_UPLOAD_SIGNING_KEY',
    },
    async () => {
      const secrets = [
        'SUPER_SECRET_PDF_TOOL_TOKEN',
        'SUPER_SECRET_STORAGE_TOKEN',
        'sk_test_SUPER_SECRET',
        'SUPER_SECRET_PURCHASE_TOKEN_VALUE',
        'SUPER_SECRET_HOOK',
        'SUPER_SECRET_NETLIFY_TOKEN',
        'ghp_SUPER_SECRET',
        'SUPER_SECRET_UPLOAD_SIGNING_KEY',
      ];

      const result = await callCapabilityStatus();
      const serialized = JSON.stringify(result);
      for (const secret of secrets) {
        assert.ok(!serialized.includes(secret), `capability_status response must never contain ${secret}`);
      }

      // Every family reports only the two documented fields — booleans and names.
      const families = result.structuredContent.families as Record<string, { configured: boolean; missing: string[] }>;
      for (const [family, entry] of Object.entries(families)) {
        assert.deepEqual(Object.keys(entry).sort(), ['configured', 'missing'], `unexpected shape for ${family}`);
        assert.equal(typeof entry.configured, 'boolean');
        assert.ok(Array.isArray(entry.missing));
        for (const name of entry.missing) assert.equal(typeof name, 'string');
      }
    }
  );
});

test('the mail family tells OFF apart from BROKEN (W19 T19.7)', async () => {
  await withEnv({}, () => {
    // Opted out: not usable, but nothing is wrong.
    assert.deepEqual(getCapabilityStatus().families.mail, { configured: false, missing: [] });
  });
  await withEnv({ MAIL_PROVIDER: 'none' }, () => {
    assert.deepEqual(getCapabilityStatus().families.mail, { configured: false, missing: [] });
  });
  await withEnv({ MAIL_PROVIDER: 'resend' }, () => {
    // Opted IN with the wiring incomplete: a real gap, named.
    assert.deepEqual(getCapabilityStatus().families.mail, {
      configured: false,
      missing: ['MAIL_API_KEY', 'MAIL_FROM'],
    });
  });
  await withEnv({ MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'k', MAIL_FROM: 'a@b.com' }, () => {
    assert.deepEqual(getCapabilityStatus().families.mail, { configured: true, missing: [] });
  });
  await withEnv({ MAIL_PROVIDER: 'postmark', MAIL_API_KEY: 'k', MAIL_FROM: 'a@b.com' }, () => {
    // A provider this build has NO adapter for. Every other var is present, so
    // a naive probe would call this green — and every notification would then
    // vanish into the null sender with the dashboard insisting mail works.
    assert.deepEqual(getCapabilityStatus().families.mail, {
      configured: false,
      missing: ['MAIL_PROVIDER'],
    });
  });
});
