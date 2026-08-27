/**
 * Fleet parity (P1): the whole OAuth connector flow, on the 'fernwell' tenant.
 *
 * Its own file, not a case in a shared suite, because site identity is a
 * per-PROCESS singleton — see `tenant-oauth-flow.ts`. Before this existed the
 * only site whose `/mcp` + `/oauth/*` shims were ever executed by a test was
 * Dr-Lurie's, so a core change that broke the other three tenants' connect
 * flow had nothing to fail against.
 */
import test from 'node:test';

import { handler as oauthHandler } from '../../sites/fernwell/netlify/functions/mcp-oauth.js';
import { handler as mcpHandler } from '../../sites/fernwell/netlify/functions/mcp.js';
import { runTenantOAuthFlow, type LambdaLikeHandler } from './tenant-oauth-flow.js';

const HOST = 'kugel-fernwell.netlify.app';
const ADMIN_EMAIL = 'owner@example.com';

const previousEnv = {
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  LAMBDA_TASK_ROOT: process.env.LAMBDA_TASK_ROOT,
  MCP_HTTP_AUTH_TOKEN: process.env.MCP_HTTP_AUTH_TOKEN,
};

test.beforeEach(() => {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  // The gate must be opened by the OAUTH token, not by an absent shared secret.
  process.env.MCP_HTTP_AUTH_TOKEN = 'a-different-shared-secret';
  delete process.env.LAMBDA_TASK_ROOT;
});

test.afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('fernwell: register → authorize → consent → token → an authorized tools/list', async () => {
  await runTenantOAuthFlow({
    oauthHandler: oauthHandler as unknown as LambdaLikeHandler,
    mcpHandler: mcpHandler as unknown as LambdaLikeHandler,
    host: HOST,
    adminEmail: ADMIN_EMAIL,
  });
});
