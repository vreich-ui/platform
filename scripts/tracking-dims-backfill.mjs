#!/usr/bin/env node

/**
 * One-shot: re-push `node_strategy` labels for every published article (P2, KI-08).
 *
 * WHY IT IS NEEDED. `scripts/tracking-dims-push.mjs` sources these rows from the
 * committed EXPORT, and the export is stripped of every `private` block on the
 * way out (`materializers/shared.ts` `stripPrivate`). So from 2026-09-03 — the
 * day the strip landed — every `node_strategy` row that script pushed carried
 * NULL `strategy`/`intent`. Nothing failed; the columns were simply empty, and
 * CMS-Agent's strategy grain drops a row with neither label. Publishing now
 * pushes the labels from the store (`lib/tracking-dims-publish.ts`), but only
 * for articles published SINCE that change. This fills in the rest.
 *
 * WHY A RE-PUSH IS SAFE, AND WHY IT ONLY EVER FILLS. The sink upserts with
 * `strategy = COALESCE(EXCLUDED.strategy, node_strategy.strategy)`
 * (kugel-data `netlify/functions/tracking-sink-dims.ts`), so a row that already
 * has a label keeps it and a NULL never overwrites one. Running this twice is a
 * no-op; running it after the postbuild script is a no-op the other way round.
 *
 * WHERE THE LABELS COME FROM. `object_get` with `projection: "nodes"` — the
 * envelope plus the FULL body, without the history ledger (a live article sits
 * at version 88 and its ledger can outweigh the article). The store is not
 * redacted; only the export is. No blob credential is needed: this speaks the
 * tenant's own MCP surface, exactly as `scripts/backfill-visual-standard.mjs`
 * does.
 *
 * DRY RUN IS THE DEFAULT, as with every backfill in this repository. It reads,
 * counts, and POSTs nothing. `--apply` is the only path that writes.
 *
 *   node scripts/tracking-dims-backfill.mjs --site drlurie --endpoint https://…/mcp
 *   node scripts/tracking-dims-backfill.mjs --site drlurie --endpoint https://…/mcp --apply
 *
 * Env: MCP_HTTP_AUTH_TOKEN (the tenant bearer), TRACKING_SINK_URL,
 * TRACKING_SINK_TOKEN, TRACKING_PROJECT_ID. No value is ever printed.
 */
import process from 'node:process';

import { createTool } from './backfill-visual-standard.mjs';

const stringOrNull = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * TWIN OF `nodeStrategyRowsFromBody` in
 * `packages/core/server/lib/tracking-dims-publish.ts`, and of the `node_strategy`
 * branch of `dimensionRowsForExport` in `scripts/tracking-dims-push.mjs`. Three
 * implementations of one projection is two too many, and the only reason for it
 * is that this repository has no TypeScript runner for scripts. They are held
 * together by fixture: `tests/scripts/tracking-dims-backfill.test.mjs` asserts
 * this one against the same article the TypeScript test uses. Change one, change
 * all three, or the fixture test fails — which is the point.
 */
export const nodeStrategyRowsFromRecord = (objectId, body) => {
  if (!isRecord(body) || !Array.isArray(body.nodes)) return [];
  const rows = [];
  body.nodes.forEach((node, position) => {
    if (!isRecord(node)) return;
    const nodeId = stringOrNull(node.id);
    if (!nodeId) return;
    const priv = isRecord(node.private) ? node.private : {};
    rows.push({
      object_id: objectId,
      node_id: nodeId,
      strategy: stringOrNull(priv.strategy),
      intent: stringOrNull(priv.intent),
      node_kind: stringOrNull(node.kind),
      position,
    });
  });
  return rows;
};

/** Counts only — a summary that named a strategy would put editorial annotation in a build log. */
export const summarise = (perArticle) => {
  const rows = perArticle.flatMap((entry) => entry.rows);
  return {
    articles: perArticle.length,
    rows: rows.length,
    labelled: rows.filter((row) => row.strategy !== null || row.intent !== null).length,
    articlesWithNoLabels: perArticle.filter((entry) => entry.rows.every((row) => row.strategy === null && row.intent === null))
      .length,
  };
};

/** Every PUBLISHED article, with its node_strategy rows. Never throws on one bad article. */
export const collectPublishedArticles = async ({ tool, log = console.log }) => {
  const listed = await tool('object_list', { object_type: 'content_item', status: 'active' });
  if (listed.isError) {
    log(`[tracking-dims-backfill] object_list failed: ${JSON.stringify(listed.data).slice(0, 200)}`);
    return { perArticle: [], failed: true };
  }
  const objects = Array.isArray(listed.data?.objects) ? listed.data.objects : [];
  const published = objects.filter((entry) => stringOrNull(entry?.published_time));
  const perArticle = [];
  for (const entry of published) {
    const objectId = stringOrNull(entry.object_id);
    if (!objectId) continue;
    const got = await tool('object_get', { object_type: 'content_item', object_id: objectId, projection: 'nodes' });
    if (got.isError) {
      log(`[tracking-dims-backfill] ${objectId}: object_get failed, skipped`);
      continue;
    }
    perArticle.push({ objectId, rows: nodeStrategyRowsFromRecord(objectId, got.data?.record?.body) });
  }
  return { perArticle, failed: false, listed: objects.length, published: published.length };
};

/** One POST carrying only the node_strategy family. Never throws. */
export const pushRows = async ({ rows, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) => {
  const sinkUrl = env.TRACKING_SINK_URL?.trim();
  const token = env.TRACKING_SINK_TOKEN?.trim();
  const projectId = env.TRACKING_PROJECT_ID?.trim();
  if (!sinkUrl || !token || !projectId) return { ok: false, skipped: 'missing_configuration' };
  if (rows.length === 0) return { ok: true, skipped: 'no_rows' };
  try {
    const response = await fetchImpl(`${sinkUrl.replace(/\/+$/, '')}/dims`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, node_strategy: rows }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export const runBackfill = async ({ tool, apply = false, env = process.env, fetchImpl = globalThis.fetch, log = console.log }) => {
  const collected = await collectPublishedArticles({ tool, log });
  const counts = summarise(collected.perArticle);
  log(
    `[tracking-dims-backfill] ${counts.articles} published article(s), ${counts.rows} node_strategy row(s), ` +
      `${counts.labelled} labelled, ${counts.articlesWithNoLabels} article(s) with no label at all`
  );
  if (counts.labelled === 0) {
    // Every article unlabelled means the labels are not in the store either —
    // a different fault from the one this exists to repair, and re-pushing
    // nulls would achieve nothing while looking like a successful backfill.
    log('[tracking-dims-backfill] nothing to fill: no article carries a label in the store. Investigate before applying.');
  }
  if (!apply) {
    log('[tracking-dims-backfill] DRY RUN — nothing was sent. Re-run with --apply to push.');
    return { ...counts, applied: false, failed: collected.failed };
  }
  const pushed = await pushRows({ rows: collected.perArticle.flatMap((entry) => entry.rows), env, fetchImpl });
  log(
    pushed.skipped
      ? `[tracking-dims-backfill] not sent (${pushed.skipped})`
      : pushed.ok
        ? `[tracking-dims-backfill] pushed ${counts.rows} row(s)`
        : `[tracking-dims-backfill] push failed (${pushed.status ?? pushed.error})`
  );
  return { ...counts, applied: true, failed: collected.failed || !pushed.ok };
};

export const parseArgs = (argv) => {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return { slug: value('site'), endpoint: value('endpoint'), apply: flag('apply') };
};

export const main = async (argv) => {
  const opts = parseArgs(argv);
  if (!opts.slug || !opts.endpoint) {
    console.error('[tracking-dims-backfill] pass --site <slug> --endpoint <tenant /mcp url>');
    process.exitCode = 2;
    return;
  }
  const token = process.env.MCP_HTTP_AUTH_TOKEN;
  if (!token) {
    console.error('[tracking-dims-backfill] MCP_HTTP_AUTH_TOKEN is not set');
    process.exitCode = 2;
    return;
  }
  const result = await runBackfill({ tool: createTool(opts.endpoint, token), apply: opts.apply });
  process.exitCode = result.failed ? 1 : 0;
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('[tracking-dims-backfill] failed:', error);
    process.exitCode = 1;
  });
}
