#!/usr/bin/env node
/**
 * OBJECT-HISTORY MEASUREMENT (KNOWN_ISSUES.md #3) — read-only sizing of
 * `ObjectRecord.history[]` growth, written FIRST per that entry's explicit
 * instruction ("measure first, against the real store, before committing to
 * a design"). This script does not fix anything — no cap, no spill, no
 * write path touched. It only measures and reports.
 *
 * Two independent data sources, never mixed silently:
 *
 *   OFFLINE (default, always available, safe anywhere) — reads the
 *   committed per-object exports under sites/<slug>/data/site/**\/*.json.
 *   Each export carries `__generated.record_version`, which is an EXACT
 *   proxy for `history.length` at export time — every code path that
 *   appends a history entry bumps `version` by the same count in the same
 *   write, with no exception found in the object-store lib:
 *     - create:                object-verbs.ts:990-991        (history+1, version=1)
 *     - patch (N ops/call):    object-patch-apply.ts:1178-1181 (history+=N, version+=N)
 *     - checkout/checkin/
 *       refresh/force_release: object-lock.ts (each: history+1, version+1)
 *     - publish stamp:         object-publish.ts:329-343 ("every write does")
 *     - submit_review/
 *       review_decide/discard: review-state.ts:6, :134-146, :220-235 ("every
 *                               write here bumps version")
 *     - retire:                object-retire.ts:208-222 (history+1, version+1)
 *   So `record_version` IS the true lifetime history-entry count, no
 *   estimation involved. What the export CANNOT give us: the *bytes* of any
 *   history entry (exports carry only the materialized body, never
 *   `history[]` itself) or real store/network timing. Those fields are
 *   reported as `null` with an explicit reason in offline mode — never
 *   guessed, per the KNOWN_ISSUES ask ("Do not fake numbers").
 *
 *   LIVE (--live) — calls each site's own `/mcp` endpoint the same way
 *   scripts/fleet-capability-probe.mjs does (tools/call over fetch, Bearer
 *   token from env, never argv): `object_inventory` first to enumerate every
 *   object (mirrors the real server-side sweep in object-verbs.ts's
 *   `case 'inventory'`), then `object_get` per object (capped by --limit,
 *   default 25, unless --all-objects) to fetch the FULL record — the only
 *   verb that returns `history[]` at all (object-verbs.ts:839-842). From
 *   that this script computes real body/history/total bytes and the real
 *   sweep's wall-clock + bytes-fetched. A site with no
 *   MCP_HTTP_AUTH_TOKEN__<SLUG> set is reported "token missing" and
 *   skipped — never a crash, never a silent fabricated number.
 *
 * Usage:
 *   node scripts/measure-object-history.mjs                       # offline, all committed sites
 *   node scripts/measure-object-history.mjs --site sites/drlurie   # offline, one site
 *   node scripts/measure-object-history.mjs --live --all           # live, every FLEET_SITES entry with a token set
 *   node scripts/measure-object-history.mjs --live --site drlurie --endpoint <url> [--limit 50] [--all-objects]
 *   options: --json <path>   also write the full machine-readable report there
 *
 * Exit code: 0 always (a measurement tool never fails the build); non-zero
 * only on a usage error (2).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FLEET_SITES, tokenEnvName } from './fleet-capability-probe.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── args ─────────────────────────────────────────────────────────────────

const parseArgs = (argv) => {
  const opts = { live: false, all: false, sites: [], offlineSites: [], limit: 25, allObjects: false, jsonPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') opts.live = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--all-objects') opts.allObjects = true;
    else if (arg === '--site') {
      opts.sites.push({ slug: argv[i + 1] });
      opts.offlineSites.push(argv[i + 1]);
      i += 1;
    } else if (arg === '--endpoint') {
      const last = opts.sites[opts.sites.length - 1];
      if (!last || last.endpoint) {
        console.error(
          '[measure-object-history] --endpoint must directly follow the --site <slug-or-path> it belongs to'
        );
        return null;
      }
      last.endpoint = argv[i + 1];
      i += 1;
    } else if (arg === '--limit') {
      opts.limit = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--json') {
      opts.jsonPath = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    }
  }
  return opts;
};

const usage =
  'usage: node scripts/measure-object-history.mjs [--site sites/<slug>]... [--json <path>]\n' +
  '       node scripts/measure-object-history.mjs --live (--all | (--site <slug> --endpoint <url>)...) [--limit N] [--all-objects] [--json <path>]';

// ── shared stats helpers ────────────────────────────────────────────────

const percentile = (sortedValues, p) => {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
};

const distribution = (values) => {
  if (values.length === 0) return { min: null, median: null, p90: null, max: null, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1],
  };
};

const byteSize = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const fmtBytes = (n) => (n === null || n === undefined ? 'n/a' : `${n.toLocaleString()} B`);

// ── OFFLINE mode ─────────────────────────────────────────────────────────

/** Every sites/<slug> under the repo that has a committed data/site export tree. */
const discoverOfflineSites = () => {
  const sitesDir = path.join(repoRoot, 'sites');
  if (!fs.existsSync(sitesDir)) return [];
  return fs
    .readdirSync(sitesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `sites/${entry.name}`)
    .filter((rel) => fs.existsSync(path.join(repoRoot, rel, 'data', 'site')));
};

const walkJsonFiles = (dir) => {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

/**
 * One committed export -> a measured row, or null if it isn't an object
 * export at all (e.g. sites/<slug>/data/site/redirects.json, which carries
 * no `__generated` envelope and isn't a governed object).
 */
const rowFromExportFile = (sitePathRel, absPath) => {
  const raw = fs.readFileSync(absPath, 'utf8');
  const fileBytes = Buffer.byteLength(raw, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      skipped: true,
      reason: `unparseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      path: absPath,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.__generated) {
    return { skipped: true, reason: 'no __generated envelope (not an object export)', path: absPath };
  }
  const generated = parsed.__generated;
  const from = typeof generated.from === 'string' ? generated.from : null;
  // `objects/<type>/by-id/<id>.json` — the exact key shape objectRecordKey()
  // writes (packages/core/server/lib/object-store-keys.ts).
  const match = from ? from.match(/^objects\/([^/]+)\/by-id\/([^/]+)\.json$/) : null;
  return {
    skipped: false,
    site: sitePathRel,
    object_type: match ? match[1] : null,
    object_id: match ? match[2] : path.basename(absPath, '.json'),
    export_path: path.relative(repoRoot, absPath),
    // EXACT (see header comment) — not an estimate.
    entry_count: typeof generated.record_version === 'number' ? generated.record_version : null,
    export_bytes: fileBytes,
    // The export's own body-shaped payload approximates production
    // `body` bytes closely (same JSON, minus the `__generated` wrapper) —
    // labeled "export_bytes" rather than "body_bytes" so it is never
    // confused with a live-measured figure.
    history_bytes: null,
    history_bytes_reason:
      'not present in committed exports — exports carry only the materialized body, never history[]. Requires --live.',
    total_bytes: null,
    total_bytes_reason: 'requires history_bytes; see history_bytes_reason.',
  };
};

const runOffline = (opts) => {
  const siteRels = opts.offlineSites.length > 0 ? opts.offlineSites : discoverOfflineSites();
  const allRows = [];
  const skipped = [];
  for (const siteRel of siteRels) {
    const dataDir = path.join(repoRoot, siteRel, 'data', 'site');
    for (const file of walkJsonFiles(dataDir)) {
      const row = rowFromExportFile(siteRel, file);
      if (row.skipped) skipped.push({ path: path.relative(repoRoot, row.path), reason: row.reason });
      else allRows.push(row);
    }
  }
  return { mode: 'offline', sites: siteRels, rows: allRows, skipped };
};

// ── LIVE mode (same tools/call-over-fetch transport as fleet-capability-probe.mjs) ──

let rpcId = 0;
const callTool = async (endpoint, token, name, args) => {
  const startedAt = Date.now();
  let response;
  let requestBytes = 0;
  try {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args ?? {} },
    });
    requestBytes = Buffer.byteLength(body, 'utf8');
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    });
  } catch (error) {
    return {
      ok: false,
      error: `network error: ${error instanceof Error ? error.message : String(error)}`,
      ms: Date.now() - startedAt,
    };
  }
  const text = await response.text();
  const responseBytes = Buffer.byteLength(text, 'utf8');
  let parsedBody;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: `non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`,
      ms: Date.now() - startedAt,
      requestBytes,
      responseBytes,
    };
  }
  const result = parsedBody.result ?? {};
  const isError = Boolean(result.isError) || Boolean(parsedBody.error);
  return {
    ok: !isError,
    httpStatus: response.status,
    data: result.structuredContent ?? parsedBody.error ?? {},
    ms: Date.now() - startedAt,
    requestBytes,
    responseBytes,
  };
};

const runLiveSite = async (site, limit, allObjects) => {
  const tokenEnv = tokenEnvName(site.slug);
  const token = process.env[tokenEnv];
  if (!token)
    return {
      slug: site.slug,
      ok: false,
      error: `${tokenEnv} is not set — skipped (offline mode still covers this site)`,
    };

  const sweepStartedAt = Date.now();
  const inventory = await callTool(site.endpoint, token, 'object_inventory', {});
  if (!inventory.ok || !Array.isArray(inventory.data?.objects)) {
    return {
      slug: site.slug,
      ok: false,
      error: `object_inventory failed: ${JSON.stringify(inventory.data ?? inventory.error).slice(0, 200)}`,
    };
  }
  const allObjectsList = inventory.data.objects; // [{object_id, object_type, ...}]
  const toFetch = allObjects ? allObjectsList : allObjectsList.slice(0, limit);

  let bytesFetched = inventory.responseBytes ?? 0;
  const rows = [];
  const fetchErrors = [];
  for (const item of toFetch) {
    const got = await callTool(site.endpoint, token, 'object_get', {
      object_type: item.object_type,
      object_id: item.object_id,
    });
    bytesFetched += got.responseBytes ?? 0;
    if (!got.ok || !got.data?.record) {
      fetchErrors.push({
        object_type: item.object_type,
        object_id: item.object_id,
        error: JSON.stringify(got.data ?? got.error).slice(0, 200),
      });
      continue;
    }
    const record = got.data.record;
    const historyBytes = byteSize(record.history ?? []);
    const bodyBytes = byteSize(record.body ?? null);
    const totalBytes = byteSize(record);
    rows.push({
      site: site.slug,
      object_type: record.object_type,
      object_id: record.object_id,
      entry_count: Array.isArray(record.history) ? record.history.length : null,
      history_bytes: historyBytes,
      body_bytes: bodyBytes,
      total_bytes: totalBytes,
    });
  }
  const sweepMs = Date.now() - sweepStartedAt;

  return {
    slug: site.slug,
    ok: true,
    objectsInStore: allObjectsList.length,
    objectsFetched: toFetch.length,
    sampled: !allObjects && allObjectsList.length > limit,
    sweepMs,
    bytesFetched,
    rows,
    fetchErrors,
  };
};

const runLive = async (opts) => {
  const targets = opts.all
    ? FLEET_SITES
    : opts.sites.map((s) => ({ slug: s.slug, endpoint: s.endpoint })).filter((s) => s.endpoint);
  if (targets.length === 0) {
    console.error('[measure-object-history] --live requires --all or at least one --site <slug> --endpoint <url>');
    return { mode: 'live', results: [] };
  }
  const results = [];
  for (const site of targets) {
    results.push(await runLiveSite(site, opts.limit, opts.allObjects)); // sequential: same reasoning as fleet-capability-probe.mjs (ordered output, no thundering herd against production)
  }
  return { mode: 'live', results };
};

// ── report rendering ────────────────────────────────────────────────────

const renderOfflineReport = (result) => {
  const lines = [];
  lines.push('=== OBJECT-HISTORY MEASUREMENT — OFFLINE MODE ===');
  lines.push(`sites scanned: ${result.sites.join(', ')}`);
  lines.push(
    `NOTE: this mode reads committed exports (sites/<slug>/data/site/**/*.json), not the live store. ` +
      `entry_count comes from each export's __generated.record_version, which is an EXACT proxy for ` +
      `history.length (see script header for the code citations) — NOT an estimate. history_bytes and ` +
      `total_bytes are NOT measurable from a committed export (it never carries history[]) and are reported ` +
      `as null. Run with --live for real byte figures.`
  );
  if (result.skipped.length) {
    lines.push(`(${result.skipped.length} committed JSON file(s) skipped as non-object-exports, e.g. redirects.json)`);
  }
  lines.push('');

  const withCounts = result.rows.filter((r) => r.entry_count !== null);
  const counts = withCounts.map((r) => r.entry_count);
  const dist = distribution(counts);
  lines.push(`objects measured: ${result.rows.length}`);
  lines.push(
    `history ENTRY COUNT distribution (exact, from record_version): min=${dist.min} median=${dist.median} p90=${dist.p90} max=${dist.max}`
  );
  lines.push('');

  const worst = [...withCounts].sort((a, b) => b.entry_count - a.entry_count).slice(0, 10);
  lines.push('worst offenders by entry_count:');
  for (const row of worst) {
    lines.push(
      `  ${row.entry_count.toString().padStart(4)}  ${row.site}/${row.object_type}/${row.object_id}  (export ${fmtBytes(row.export_bytes)})`
    );
  }
  lines.push('');

  const totalExportBytes = result.rows.reduce((sum, r) => sum + r.export_bytes, 0);
  const totalEntries = counts.reduce((sum, c) => sum + c, 0);
  lines.push(`total committed export bytes (body-only, ALL objects): ${fmtBytes(totalExportBytes)}`);
  lines.push(
    `total lifetime history-entry count across all objects (sum of record_version): ${totalEntries.toLocaleString()}`
  );
  lines.push('');
  lines.push(
    'CANNOT be produced offline (need --live): history[] byte size per object or in aggregate; the ' +
      'history-bytes-vs-everything-else fraction of total store bytes; real full-sweep wall-clock and bytes ' +
      'fetched from the live blob store.'
  );
  return lines.join('\n');
};

const renderLiveReport = (result) => {
  const lines = [];
  lines.push('=== OBJECT-HISTORY MEASUREMENT — LIVE MODE ===');
  for (const site of result.results) {
    lines.push('');
    lines.push(`--- ${site.slug} ---`);
    if (!site.ok) {
      lines.push(`  SKIPPED: ${site.error}`);
      continue;
    }
    lines.push(
      `  objects in store: ${site.objectsInStore} · fetched full record for: ${site.objectsFetched}` +
        (site.sampled ? ` (SAMPLED — pass --all-objects for a true full sweep)` : ' (full sweep)')
    );
    lines.push(`  sweep wall-clock: ${site.sweepMs} ms · bytes fetched over the wire: ${fmtBytes(site.bytesFetched)}`);
    if (site.fetchErrors.length)
      lines.push(`  object_get failures: ${site.fetchErrors.length} (see --json output for detail)`);

    const counts = site.rows.map((r) => r.entry_count).filter((v) => v !== null);
    const historyBytesArr = site.rows.map((r) => r.history_bytes);
    const totalBytesArr = site.rows.map((r) => r.total_bytes);
    const cDist = distribution(counts);
    const hDist = distribution(historyBytesArr);
    lines.push(
      `  entry_count distribution:  min=${cDist.min} median=${cDist.median} p90=${cDist.p90} max=${cDist.max}`
    );
    lines.push(
      `  history_bytes distribution: min=${fmtBytes(hDist.min)} median=${fmtBytes(hDist.median)} p90=${fmtBytes(hDist.p90)} max=${fmtBytes(hDist.max)}`
    );

    const totalHistory = historyBytesArr.reduce((a, b) => a + b, 0);
    const totalRecord = totalBytesArr.reduce((a, b) => a + b, 0);
    const fraction = totalRecord > 0 ? totalHistory / totalRecord : null;
    lines.push(
      `  history bytes / total record bytes, across ${site.rows.length} fetched objects: ${fmtBytes(totalHistory)} / ${fmtBytes(totalRecord)}` +
        (fraction !== null ? ` = ${(fraction * 100).toFixed(1)}%` : '')
    );

    const worst = [...site.rows].sort((a, b) => b.history_bytes - a.history_bytes).slice(0, 10);
    lines.push('  worst offenders by history_bytes:');
    for (const row of worst) {
      lines.push(
        `    ${fmtBytes(row.history_bytes).padStart(12)}  ${row.object_type}/${row.object_id}  (${row.entry_count} entries, total ${fmtBytes(row.total_bytes)})`
      );
    }
  }
  return lines.join('\n');
};

// ── main ─────────────────────────────────────────────────────────────────

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(usage);
    return;
  }

  const output = { generated_at: new Date().toISOString() };

  if (opts.live) {
    const live = await runLive(opts);
    output.live = live;
    console.log(renderLiveReport(live));
  } else {
    const offline = runOffline(opts);
    output.offline = offline;
    console.log(renderOfflineReport(offline));
  }

  if (opts.jsonPath) {
    fs.mkdirSync(path.dirname(path.resolve(repoRoot, opts.jsonPath)), { recursive: true });
    fs.writeFileSync(path.resolve(repoRoot, opts.jsonPath), `${JSON.stringify(output, null, 2)}\n`);
    console.log(`\n[measure-object-history] full report written to ${opts.jsonPath}`);
  }
};

main();
