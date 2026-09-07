#!/usr/bin/env node
/**
 * system-contracts.mjs — drift gate for docs/system/*.md.
 *
 * Extracts the literals the cross-repository system documentation relies on
 * from whichever Kugel repositories are present on disk and compares them with
 * docs/system/system-contracts.lock.json.
 *
 *   node scripts/docs/system-contracts.mjs --write   # regenerate the lock
 *   node scripts/docs/system-contracts.mjs --check   # fail on any drift (default)
 *
 * The platform section is always extracted (this repo). The cms-agent, pdf-tool
 * and kugel-data sections are extracted only when a checkout is found — set
 * KUGEL_SIBLINGS="/path/to/cms-agent:/path/to/pdf-tool:/path/to/kugel-data" or
 * keep the default sibling layout (../cms-agent | ../CMS-Agent, ../pdf-tool,
 * ../kugel-data). A section that cannot be extracted is skipped in --check
 * (the lock keeps its last known values) so CI without siblings stays green,
 * while a maintainer with all four clones gets the full cross-repository check.
 *
 * Every extractor is a plain regex over source text: no imports, no build,
 * no network. If a regex stops matching, the field becomes null and --check
 * fails loudly with the field name — that is the point.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const platformRoot = resolve(here, '..', '..');
const lockPath = join(platformRoot, 'docs', 'system', 'system-contracts.lock.json');

const read = (root, rel) => {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stringArray = (src, re) => {
  const m = src?.match(re);
  if (!m) return null;
  return [...stripComments(m[1]).matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
};
const objectKeys = (src, re) => {
  const m = src?.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((x) => x[1]);
};
const firstInt = (src, re) => {
  const m = src?.match(re);
  return m ? Number(m[1]) : null;
};
const firstString = (src, re) => {
  const m = src?.match(re);
  return m ? m[1] : null;
};
const sortedUnique = (arr) => (arr ? [...new Set(arr)].sort() : null);

// ---------------------------------------------------------------- platform
function extractPlatform(root) {
  const client = read(root, 'packages/core/server/lib/agent/cms-agent-client.ts');
  const kinds = read(root, 'packages/core/schema/bodies/tracking-config-v1.ts');
  const trackingEvents = read(root, 'packages/core/server/lib/tracking-events.ts');
  const commerce = read(root, 'packages/core/server/lib/commerce-events.ts');
  const artifacts = read(root, 'packages/core/server/lib/artifacts.ts');
  const grant = read(root, 'packages/core/server/lib/pdf-tool-storage-grant.ts');
  const naming = read(root, 'packages/core/lib/agents-naming.ts');
  const reqStore = read(root, 'packages/core/server/lib/requests/store.ts');
  const agentTools = read(root, 'packages/core/server/lib/agent/tools.ts');
  const idem = read(root, 'packages/core/server/lib/idempotency-store.ts');
  const dims = read(root, 'scripts/tracking-dims-push.mjs');
  const toolTest = read(root, 'packages/core/server/lib/mcp-tool-definitions.test.ts');
  const stats = read(root, 'packages/core/server/lib/own-tracker-stats.ts');
  const weights = read(root, 'scripts/lib/tracking-experiments.mjs');
  const checkout = read(root, 'packages/core/server/functions/create-checkout-session.ts');
  const webhook = read(root, 'packages/core/server/functions/stripe-webhook.ts');
  const commerceEventIds = read(root, 'packages/core/server/lib/commerce-event-ids.ts');

  // Every CMS-Agent tool name platform calls through CmsAgentClient (any generic between callTool and the paren).
  const callFiles = [
    'packages/core/server/lib/agent/tools.ts',
    'packages/core/server/lib/agent/cms-agent-client.ts',
    'packages/core/server/lib/brand-imagery-proxy.ts',
    'packages/core/server/lib/requests/publication-outputs.ts',
    'packages/core/server/lib/requests/sweep.ts',
    'packages/core/server/lib/requests/activity.ts',
    'packages/core/server/lib/requests/budget-override.ts',
    'packages/core/server/functions/admin-requests.ts',
    'packages/core/server/lib/analytics-insights.ts',
  ];
  const called = new Set();
  for (const rel of callFiles) {
    const src = read(root, rel);
    if (!src) continue;
    for (const m of src.matchAll(/callTool[^(]*\(\s*['"]([a-z_]+)['"]/g)) called.add(m[1]);
    // budget-override.ts builds the write tool name from a ternary — capture both literals.
    for (const m of src.matchAll(/['"](workflow_set_node_budget_override|workspace_update_node_model_config)['"]/g)) called.add(m[1]);
  }

  const propsBlock = trackingEvents?.match(/TRACKING_PROPS_ALLOWLIST[^=]*=\s*\{([\s\S]*?)\n\};/);
  const propsAllowlist = propsBlock
    ? Object.fromEntries(
        [...propsBlock[1].matchAll(/^\s*([a-z_]+)\s*:\s*\[([^\]]*)\]/gm)].map((m) => [
          m[1],
          [...m[2].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]),
        ])
      )
    : null;

  const dimsRowKeys = dims
    ? {
        object_version: sortedUnique(
          stripComments((dims.match(/object_version:\s*\[\s*\{([\s\S]*?)\}\s*,?\s*\]/) ?? [])[1] ?? '').match(/^\s*([a-z_]+)\s*[:,]/gm)?.map((s) => s.trim().replace(/[:,]$/, '')) ?? null
        ),
        producer: '{object_id, version, ...producer(run_id, node_id, prompt_version, model)}',
        node_strategy: sortedUnique(
          (dims.match(/rows\.node_strategy\.push\(\{([\s\S]*?)\}\)/) ?? [])[1]?.match(/^\s*([a-z_]+)\s*[:,]/gm)?.map((s) => s.trim().replace(/[:,]$/, '')) ?? null
        ),
      }
    : null;

  return {
    cmsAgentBounds: {
      maxTools: firstInt(client, /maxTools:\s*(\d+)/),
      legacyMaxTools: firstInt(client, /legacyMaxTools:\s*(\d+)/),
      maxMessages: firstInt(client, /maxMessages:\s*(\d+)/),
    },
    cmsAgentToolsCalled: sortedUnique([...called]),
    trackingEventKinds: stringArray(kinds, /TRACKING_EVENT_KINDS\s*=\s*\[([\s\S]*?)\]\s*as const/),
    trackingPropsAllowlist: propsAllowlist,
    commerceEventTypes: stringArray(commerce, /commerceEventTypes\s*=\s*\[([\s\S]*?)\]\s*as const/),
    commerceSinkKindSource: firstString(commerce, /kind:\s*(event\.type)/),
    // Checkout mints the purchase id by calling the shared derivation (S-01 fix, platform #700)
    // rather than inlining `event_id: randomUUID()` any more — read the seed the shared helper
    // actually hashes so this stays truthful if the event name it derives from ever changes.
    checkoutEventIdGenerator: (() => {
      if (checkout && /event_id:\s*randomUUID\(\)/.test(checkout)) return 'randomUUID';
      if (!checkout || !commerceEventIds || !/checkoutCompletedEventId\(session\.id\)/.test(checkout)) return null;
      const seed = commerceEventIds.match(/checkoutCompletedEventId[\s\S]*?deterministicUuid\(`\$\{sessionId\}:([a-z_]+)`\)/);
      return seed ? `deterministicUuid(session.id:${seed[1]})` : null;
    })(),
    webhookEventIdGenerator: webhook && /event_id:\s*deterministicUuid\(/.test(webhook) ? 'deterministicUuid(session.id:type)' : null,
    allowedArtifactReferenceKeys: stringArray(artifacts, /allowedArtifactReferenceKeys\s*=\s*new Set\(\[([\s\S]*?)\]\)/),
    grantStores: (() => {
      const m = grant?.match(/pdfToolStorageStores\s*=\s*\{([\s\S]*?)\}\s*as const/);
      return m ? Object.fromEntries([...m[1].matchAll(/([A-Za-z]+):\s*'([^']+)'/g)].map((x) => [x[1], x[2]])) : null;
    })(),
    grantTtlMs: firstInt(grant, /pdfToolStorageGrantTtlMs\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/) ? firstInt(grant, /pdfToolStorageGrantTtlMs\s*=\s*(\d+)/) * 60 * 1000 : null,
    grantLimitsKeys: objectKeys(read(root, 'packages/core/lib/media-policy.ts'), /export type MediaPolicyLimits\s*=\s*\{([\s\S]*?)\};/),
    requestIdRegexes: {
      'lib/agents-naming.ts': firstString(naming, /const REQUEST_ID_RE\s*=\s*(\/.*\/);/),
      'server/lib/requests/store.ts': firstString(reqStore, /REQUEST_ID_PATTERN\s*=\s*(\/.*\/);/),
      'server/lib/agent/tools.ts': firstString(agentTools, /REQUEST_ID_RE\s*=\s*(\/.*\/);/),
    },
    idempotencyReplayMarker: idem && /replayed_from_idempotency_key:\s*true/.test(idem) ? 'boolean true' : null,
    dimsRowKeys,
    ownStatsQuery: firstString(stats, /(\/stats\?[^`'"]+)/),
    // Query parameters the own-tracker /stats reader sends (URLSearchParams ctor keys + params.set names).
    ownStatsParams: (() => {
      const fn = stats?.match(/const statsEndpoint[\s\S]*?\n\};/)?.[0];
      if (!fn) return null;
      const names = new Set();
      for (const m of fn.matchAll(/new URLSearchParams\(\{([^}]*)\}\)/g)) for (const k of m[1].matchAll(/([a-z_]+)\s*:/g)) names.add(k[1]);
      for (const m of fn.matchAll(/params\.set\('([a-z_]+)'/g)) names.add(m[1]);
      return sortedUnique([...names]);
    })(),
    // Path the raw-export reader appends to TRACKING_SINK_URL (S-22).
    rawExportPath: [...(stats?.matchAll(/\$\{sinkUrl[^}]*\}(\/[^?`]+)\?/g) ?? [])].map((m) => m[1]).find((path) => path.includes('export')) ?? null,
    // Envelope key the build-time weights reader expects (S-24).
    weightsEnvelopeKey: weights?.match(/body\.([a-z_]+)\s*&&\s*typeof body\.[a-z_]+\s*===\s*'object'/)?.[1] ?? null,
    mcpToolCount: firstInt(toolTest, /TOOL_DEFINITIONS\.length,\s*(\d+)/),
  };
}

// ---------------------------------------------------------------- cms-agent
function extractCmsAgent(root) {
  const contract = read(root, 'src/agent/conversations/conversationContract.ts');
  const ingest = read(root, 'src/agent/improvement/trackingIngest.ts');
  const strategy = read(root, 'src/agent/improvement/strategyLearning.ts');
  const publisher = read(root, 'src/agent/workspace/publisher.ts');
  const release = read(root, 'src/agent/workspace/releaseExecution.ts');
  const capture = read(root, 'src/agent/capture/captureEngine.ts');
  const scopeLock = read(root, 'docs/site-credential-scope-lock.json');
  const manifest = read(root, 'docs/mcp-tool-manifest.json');
  const drHooks = read(root, 'src/agent/projects/drLurie/hooks.ts');
  const platformHooks = read(root, 'src/agent/projects/platform/hooks.ts');
  const scope = scopeLock ? JSON.parse(scopeLock) : null;
  return {
    maxConversationTools: firstInt(contract, /MAX_CONVERSATION_TOOLS\s*=\s*(\d+)/),
    maxTranscriptMessages: firstInt(contract, /MAX_TRANSCRIPT_MESSAGES\s*=\s*(\d+)/),
    siteClientManagerTools: scope ? sortedUnique(scope.tools ?? scope.toolAllowlist ?? []) : null,
    siteClientManagerToolCount: scope?.toolCount ?? null,
    rollupsByValues: stringArray(ingest, /type RollupGrouping\s*=\s*([^;]+);/),
    rollupsQueryParams: (() => {
      const m = ingest?.match(/ROLLUPS_QUERY_PARAM_NAMES\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
      return m ? sortedUnique([...m[1].matchAll(/:\s*"([a-z_]+)"/g)].map((x) => x[1])) : null;
    })(),
    grainUnavailableStatus: firstInt(strategy, /GRAIN_UNAVAILABLE_STATUS\s*=\s*(\d+)/),
    requestIdRegexes: { 'workspace/publisher.ts': firstString(publisher, /REQUEST_ID_PATTERN\s*=\s*(\/.*\/);/) },
    replayMarkerRead: release && /nonEmptyString\(record\.replayed_from_idempotency_key\)/.test(release) ? 'string' : null,
    credentialShapedKeys: stringArray(capture, /CREDENTIAL_SHAPED_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/),
    mcpToolCount: manifest ? JSON.parse(manifest).toolCount ?? null : null,
    drLuriePublishSendsProducer: drHooks ? /"object_publish"[\s\S]{0,400}producer/.test(drHooks) : null,
    platformPublishSendsProducer: platformHooks ? /producer:\s*ctx\.producer/.test(platformHooks) : null,
  };
}

// ---------------------------------------------------------------- pdf-tool
function extractPdfTool(root) {
  const artifacts = read(root, 'netlify/lib/artifact-core/artifacts.ts');
  const grant = read(root, 'netlify/lib/storage-grant.ts');
  const mcp = read(root, 'netlify/functions/mcp.ts');
  const worker = read(root, 'netlify/lib/capture/worker.ts');
  const policy = read(root, 'netlify/lib/capture/policy.ts');
  const iface = artifacts?.match(/export interface ArtifactReference\s*\{([\s\S]*?)\n\}/);
  const fields = iface ? sortedUnique([...iface[1].matchAll(/^\s*([A-Za-z]+)\??:/gm)].map((x) => x[1])) : null;
  const meta = mcp?.match(/const TOOL_METADATA[^=]*=\s*\[([\s\S]*?)\n\];/);
  return {
    artifactReferenceFields: fields,
    canonicalStorageStores: (() => {
      const m = grant?.match(/CANONICAL_STORAGE_STORES[^=]*=\s*\{([\s\S]*?)\};/);
      return m ? Object.fromEntries([...m[1].matchAll(/([A-Za-z]+):\s*"([^"]+)"/g)].map((x) => [x[1], x[2]])) : null;
    })(),
    supportedGrantTypes: stringArray(grant, /SUPPORTED_GRANT_TYPES\s*=\s*\[([^\]]*)\]/),
    grantLimitsRead: grant ? sortedUnique([...grant.matchAll(/limitsInput\.([A-Za-z_]+)/g)].map((x) => x[1])) : null,
    mcpToolCount: meta ? (meta[1].match(/^\s{4}name:\s*"/gm) ?? []).length : null,
    grantOptionalTools: stringArray(mcp, /GRANT_OPTIONAL_TOOLS[^=]*=\s*new Set(?:<[^>]*>)?\(\[([\s\S]*?)\]\)/),
    snapshotSchemaVersion: firstString(worker, /SNAPSHOT_SCHEMA_VERSION\s*=\s*"([^"]+)"/),
    hardMaxCapturePagesPerJob: firstInt(policy, /HARD_MAX_CAPTURE_PAGES_PER_JOB\s*=\s*(\d+)/),
  };
}

// ---------------------------------------------------------------- kugel-data
function extractKugelData(root) {
  const rollups = read(root, 'netlify/functions/_shared/rollups.ts');
  const stats = read(root, 'netlify/functions/_shared/stats.ts');
  const experiment = read(root, 'netlify/functions/_shared/experiment.ts');
  // The /stats window parsing moved into the shared helper (kugel-data S-23), so reading the
  // function file alone would report that the sink no longer reads `days`/`from`/`to` at all.
  // Both files together are what "the /stats function reads".
  const statsFn = [read(root, 'netlify/functions/tracking-sink-stats.ts'), read(root, 'netlify/functions/_shared/stats.ts')]
    .filter(Boolean)
    .join('\n') || null;
  const dimsFn = read(root, 'netlify/functions/tracking-sink-dims.ts');
  const sink = read(root, 'netlify/functions/tracking-sink.ts');
  const migrations = ['001_tracking_sink_reference.sql', '002_tracking_sink_commerce_dims_weights.sql', '003_tracking_events_commerce_event_id_idx.sql', '004_rollup_views.sql', '005_rollups_on_baseline_traffic.sql'];
  const eventKinds = new Set();
  for (const src of [stats, experiment]) {
    for (const m of src?.matchAll(/^\s*[A-Z_]+:\s*"([a-z_]+)"/gm) ?? []) eventKinds.add(m[1]);
  }
  const purchaseKinds = new Set();
  for (const rel of migrations.map((f) => `netlify/database/migrations/${f}`).concat(['netlify/functions/tracking-sink-stats.ts'])) {
    const src = read(root, rel);
    for (const m of src?.matchAll(/kind\s*=\s*'([a-z_]+)'/g) ?? []) purchaseKinds.add(m[1]);
  }
  const dimsReadKeys = dimsFn ? sortedUnique([...dimsFn.matchAll(/record\??\.([a-z_]+)/g)].map((x) => x[1])) : null;
  const requiredEvent = sink?.match(/return (row\.event_id[^?]*)\?/);
  return {
    parseByValues: (() => {
      const m = rollups?.match(/ROLLUP_VIEWS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
      return m ? sortedUnique([...m[1].matchAll(/^\s*([a-z]+):/gm)].map((x) => x[1])) : null;
    })(),
    eventKindLiterals: sortedUnique([...eventKinds]),
    purchaseKindLiterals: sortedUnique([...purchaseKinds]),
    migrations: migrations.filter((f) => existsSync(join(root, 'netlify/database/migrations', f))),
    trackingEventsHasVersionColumn: (() => {
      const src = read(root, 'schema.sql');
      const m = src?.match(/CREATE TABLE IF NOT EXISTS tracking_events \(([\s\S]*?)\);/);
      return m ? /^\s*version\s/m.test(m[1]) : null;
    })(),
    dimsReadKeys,
    statsDaysParam: statsFn ? /searchParams\.get\("days"\)/.test(statsFn) : null,
    // Every query parameter the /stats function reads.
    statsParamsRead: statsFn ? sortedUnique([...statsFn.matchAll(/searchParams\.get\("([a-z_]+)"\)/g)].map((x) => x[1])) : null,
    // Top-level keys of the /weights response envelope.
    weightsEnvelopeKeys: (() => {
      const src = read(root, 'netlify/functions/tracking-sink-weights.ts');
      const m = src?.match(/return json\(\{\s*([^}]*)\}\)/);
      return m ? sortedUnique(m[1].split(',').map((part) => part.trim().split(':')[0].trim()).filter(Boolean)) : null;
    })(),
    functions: (() => {
      const dir = join(root, 'netlify/functions');
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, '')).sort() : null;
    })(),
    requiredEventFields: requiredEvent ? sortedUnique([...requiredEvent[1].matchAll(/row\.([a-z_]+)/g)].map((x) => x[1])) : null,
    schemaFieldPersisted: sink ? /INSERT INTO tracking_events[\s\S]*?\bschema\b/.test(sink) : null,
  };
}

// ---------------------------------------------------------------- main
const siblingsRaw = process.env.KUGEL_SIBLINGS;
const siblingsEnv = siblingsRaw && siblingsRaw !== 'none' ? siblingsRaw.split(':').filter(Boolean) : [];
// KUGEL_SIBLINGS=none disables sibling discovery entirely (what CI without the other clones sees).
const candidates = (names) => [
  ...siblingsEnv,
  ...(siblingsRaw === 'none' ? [] : names.map((n) => resolve(platformRoot, '..', n))),
];
const findRepo = (names, probe) => candidates(names).find((p) => existsSync(join(p, probe)));

const repos = {
  platform: platformRoot,
  cmsAgent: findRepo(['cms-agent', 'CMS-Agent'], 'src/agent/conversations/conversationContract.ts'),
  pdfTool: findRepo(['pdf-tool'], 'netlify/lib/storage-grant.ts'),
  kugelData: findRepo(['kugel-data'], 'netlify/functions/_shared/rollups.ts'),
};

const extracted = {
  platform: extractPlatform(repos.platform),
  cmsAgent: repos.cmsAgent ? extractCmsAgent(repos.cmsAgent) : undefined,
  pdfTool: repos.pdfTool ? extractPdfTool(repos.pdfTool) : undefined,
  kugelData: repos.kugelData ? extractKugelData(repos.kugelData) : undefined,
};

const mode = process.argv.includes('--write') ? 'write' : 'check';
const previous = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { pins: {} };

if (mode === 'write') {
  const lock = {
    note: 'Generated by scripts/docs/system-contracts.mjs --write. Do not hand-edit. Sections for absent sibling repositories keep their last generated values.',
    pins: previous.pins,
    knownCrossFindings: previous.knownCrossFindings ?? [],
    platform: extracted.platform,
    cmsAgent: extracted.cmsAgent ?? previous.cmsAgent,
    pdfTool: extracted.pdfTool ?? previous.pdfTool,
    kugelData: extracted.kugelData ?? previous.kugelData,
  };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  console.log(`wrote ${lockPath} (sections: ${Object.keys(extracted).filter((k) => extracted[k]).join(', ')})`);
  process.exit(0);
}

const failures = [];
const compare = (section, actual, expected) => {
  if (!actual) return; // repo absent: skip
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected ?? {})]);
  for (const key of keys) {
    const a = JSON.stringify(actual[key] ?? null);
    const e = JSON.stringify(expected?.[key] ?? null);
    if (a !== e) failures.push(`${section}.${key}\n    lock:   ${e}\n    source: ${a}`);
    if (actual[key] === null || actual[key] === undefined) failures.push(`${section}.${key} could not be extracted (regex no longer matches) — fix the extractor or the source`);
  }
};
compare('platform', extracted.platform, previous.platform);
compare('cmsAgent', extracted.cmsAgent, previous.cmsAgent);
compare('pdfTool', extracted.pdfTool, previous.pdfTool);
compare('kugelData', extracted.kugelData, previous.kugelData);

// Cross-repository invariants the system docs assert (evaluated only when both sides are present).
const cross = [];
const p = extracted.platform;
const c = extracted.cmsAgent ?? previous.cmsAgent;
const d = extracted.kugelData ?? previous.kugelData;
const t = extracted.pdfTool ?? previous.pdfTool;
if (extracted.cmsAgent && c?.siteClientManagerTools && p.cmsAgentToolsCalled) {
  const outside = p.cmsAgentToolsCalled.filter((name) => !c.siteClientManagerTools.includes(name));
  if (outside.length) cross.push(`S-07 platform calls CMS-Agent tools outside the tenant bearer scope: ${outside.join(', ')}`);
  if (p.cmsAgentBounds.maxTools > c.maxConversationTools) cross.push(`L-24 platform maxTools ${p.cmsAgentBounds.maxTools} > CMS-Agent MAX_CONVERSATION_TOOLS ${c.maxConversationTools}`);
  if (extracted.kugelData && c.rollupsByValues && d?.parseByValues) {
    const missing = c.rollupsByValues.filter((v) => !d.parseByValues.includes(v));
    if (missing.length) cross.push(`S-04 CMS-Agent requests /rollups grains the sink rejects: ${missing.join(', ')}`);
  }
}
if (extracted.kugelData && d?.eventKindLiterals && p.trackingEventKinds) {
  const unknown = d.eventKindLiterals.filter((k) => !p.trackingEventKinds.includes(k));
  if (unknown.length) cross.push(`S-09 sink relies on event kinds platform never emits: ${unknown.join(', ')}`);
  const purchase = (d.purchaseKindLiterals ?? []).filter((k) => !p.commerceEventTypes?.includes(k));
  if (purchase.length) cross.push(`S-02 sink filters commerce kinds platform never sends: ${purchase.join(', ')}`);
  // S-23: parameters the platform /stats reader sends that the sink function never reads.
  if (p.ownStatsParams && d.statsParamsRead) {
    const ignored = p.ownStatsParams.filter((k) => !d.statsParamsRead.includes(k));
    if (ignored.length) cross.push(`S-23 platform sends /stats parameters the sink ignores: ${ignored.join(', ')}`);
  }
  // S-23/S-22: the raw-export reader targets a function the sink does not have.
  if (p.rawExportPath && d.functions && !d.functions.some((f) => f.endsWith('export'))) cross.push(`S-23 platform reads ${p.rawExportPath} but the sink has no export function`);
  // S-24: the weights envelope key platform reads vs the keys the sink returns.
  if (p.weightsEnvelopeKey && d.weightsEnvelopeKeys && !d.weightsEnvelopeKeys.includes(p.weightsEnvelopeKey)) cross.push(`S-24 platform reads /weights body.${p.weightsEnvelopeKey}; the sink returns {${d.weightsEnvelopeKeys.join(', ')}}`);
}
if (extracted.pdfTool && t?.artifactReferenceFields && p.allowedArtifactReferenceKeys) {
  const rejected = t.artifactReferenceFields.filter((f) => !p.allowedArtifactReferenceKeys.includes(f));
  const ignorable = ['artifactId', 'createdAt', 'projectId', 'requestId', 'size', 'slot']; // declared aliases pdf-tool never sets
  const real = rejected.filter((f) => !ignorable.includes(f));
  if (real.length) cross.push(`S-16 pdf-tool ArtifactReference fields platform would reject: ${real.join(', ')}`);
  for (const [k, v] of Object.entries(p.grantStores ?? {})) if (t.canonicalStorageStores?.[k] !== v) cross.push(`C-12 grant store ${k}: platform '${v}' vs pdf-tool '${t.canonicalStorageStores?.[k]}'`);
}

const known = new Set((previous.knownCrossFindings ?? []).map((s) => s.split(' ')[0]));
const newCross = cross.filter((line) => !known.has(line.split(' ')[0]));

if (failures.length || newCross.length) {
  console.error('system-contracts: DRIFT DETECTED');
  for (const f of failures) console.error('  - ' + f);
  for (const f of newCross) console.error('  - NEW cross-repo finding: ' + f);
  console.error('\nIf the change is intentional, update the system docs and run: node scripts/docs/system-contracts.mjs --write');
  process.exit(1);
}
if (cross.length) {
  console.log('system-contracts: OK (known cross-repo findings still present: ' + cross.map((s) => s.split(' ')[0]).join(', ') + ')');
} else {
  console.log('system-contracts: OK');
}
