#!/usr/bin/env node
/**
 * T2.7 — the ONE-TIME retrofit for `site_drlurie` (ruling D-B). drlurie
 * already exists and already carries two hardcoded pdf-tool brochure
 * templates that predate this wave; every NEW tenant gets the same
 * `article_brochure_v1` seed automatically at genesis (see the hook in
 * `site-genesis-drive.mjs`), so this script is deliberately NOT part of
 * that generic path — it exists only to (a) run
 * `runArticleTemplateSeed` for drlurie once, by hand, and (b) supply the
 * one piece of drlurie-specific data no fleet-generic module may hold: the
 * `byKind.sales_brochure` template id to pin.
 *
 * Judgement call (documented in full in `scripts/lib/site-pdf-defaults.mjs`):
 * of drlurie's two brochures, the 5-page ROUTINE brochure is pinned as the
 * default `sales_brochure` (more general "sell our approach" piece); the
 * 6-page niacinamide brochure stays in pdf-tool's template list, reachable
 * by explicit `template_id`, just not the kind default.
 *
 * Usage:
 *   MCP_HTTP_AUTH_TOKEN=… node scripts/seed-drlurie-pdf-defaults.mjs \
 *     --endpoint https://drluriescience.netlify.app/mcp
 *
 * Idempotent, like the function it wraps: a second run against an
 * already-seeded drlurie is a no-op (see `runArticleTemplateSeed`'s own
 * idempotency rules).
 */
import { pathToFileURL } from 'node:url';

import { DRLURIE_SALES_BROCHURE_TEMPLATE_IDS } from './lib/site-pdf-defaults.mjs';
import { createTool, runArticleTemplateSeed } from './seed-article-pdf-template.mjs';

export const DRLURIE_SITE_ID = 'site_drlurie';

const USAGE = 'usage: MCP_HTTP_AUTH_TOKEN=… node scripts/seed-drlurie-pdf-defaults.mjs --endpoint https://<host>/mcp';

export const main = async (argv) => {
  const endpointIndex = argv.indexOf('--endpoint');
  const endpoint = endpointIndex === -1 ? undefined : argv[endpointIndex + 1];
  if (!endpoint) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const key = process.env.MCP_HTTP_AUTH_TOKEN;
  if (!key) {
    console.error('[seed-drlurie-pdf-defaults] MCP_HTTP_AUTH_TOKEN is required.');
    process.exitCode = 2;
    return;
  }
  const tool = createTool(endpoint, key);
  const result = await runArticleTemplateSeed({
    tool,
    siteId: DRLURIE_SITE_ID,
    salesBrochureTemplateId: DRLURIE_SALES_BROCHURE_TEMPLATE_IDS.routine5Page,
  });
  for (const step of result.steps) console.log(JSON.stringify(step));
  console.log(result.ok ? `[seed-drlurie-pdf-defaults] OK (${result.templateId})` : `[seed-drlurie-pdf-defaults] FAILED: ${result.error}`);
  process.exitCode = result.ok ? 0 : 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('[seed-drlurie-pdf-defaults] crashed:', error.message);
    process.exit(1);
  });
}
