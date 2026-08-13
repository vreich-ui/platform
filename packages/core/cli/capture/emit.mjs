#!/usr/bin/env node
/**
 * T12.4 capture emission.  This is intentionally an MCP client, not an
 * object-store helper: a captured site is just another governed draft graph.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseCaptureRights, readProjectCapturePolicy } from './snapshot-v1.mjs';

const FORBIDDEN_VERBS = new Set(['object_publish', 'release_to_production', 'trigger_netlify_build', 'deploy']);
const REQUIRED_TYPES = ['theme', 'section_template', 'navigation', 'page'];
const sha = (value, length = 16) => createHash('sha256').update(value).digest('hex').slice(0, length);
const clone = (value) => JSON.parse(JSON.stringify(value));

export class EmissionError extends Error {}

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
      'Usage: node packages/core/cli/capture/emit.mjs --target <named-project> --mapping <mapping.v1.json> --theme <theme.v1.json> --dry-run [--repeat-threshold <N>] [--out <report.json>]\\n' +
      '   or: node packages/core/cli/capture/emit.mjs --target <named-project> --project-policy <safe-project-get.json> --endpoint <https://target/mcp> --mapping <mapping.v1.json> --theme <theme.v1.json> [--model-adapter <module.mjs>] [--out <report.json>]'
  );
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') usage();
    if (!key.startsWith('--')) usage(`Unexpected argument: ${key}`);
    if (key === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  for (const key of ['target', 'mapping', 'theme']) if (!args[key]) usage(`Missing --${key}`);
  if (!args.dryRun && !args.endpoint) usage('Live mode requires --endpoint.');
  if (!args.dryRun && !args['project-policy']) usage('Live mode requires --project-policy (a safe project.get response).');
  if (args.dryRun && args.endpoint) usage('Dry-run does not accept --endpoint: it must make no MCP calls.');
  const repeatThreshold = args['repeat-threshold'] === undefined ? 2 : Number(args['repeat-threshold']);
  if (!Number.isInteger(repeatThreshold) || repeatThreshold < 2) usage('--repeat-threshold must be an integer >= 2.');
  return { ...args, repeatThreshold };
}

function payload(result) {
  return result?.data ?? result?.structuredContent?.data ?? result?.structuredContent ?? result;
}

function targetId(result) {
  const value = payload(result);
  const project = value?.project ?? value;
  return project?.id ?? project?.project_id ?? project?.projectId ?? null;
}

/**
 * Project policy is deliberately read only from the target project response,
 * and only through the one canonical reader — a CMS-Agent `ProjectCapturePolicy`
 * under `capturePolicy` (or its snake_case envelope spelling). There is no
 * third spelling to fall back to: an unrecognized shape stops emission.
 */
export function capturePolicyFromProject(result, target) {
  if (targetId(result) !== target) throw new EmissionError(`Target binding mismatch: expected ${target}.`);
  const policy = readProjectCapturePolicy(result);
  if (!policy) throw new EmissionError('Target project contract has no capture policy.');
  return policy;
}

const CONTENT_RIGHT = 'retain_allowed_origin_content';
const MEDIA_RIGHT = 'retain_referenced_allowed_origin_media';

/**
 * Rights are read with the canonical enum, not a looser local reading: a value
 * outside `ProjectCapturePolicy["rights"]` is a malformed contract and stops
 * emission rather than being silently treated as "no rights".
 */
function policyRights(policy) {
  try {
    return parseCaptureRights(policy?.rights);
  } catch (error) {
    throw new EmissionError(`Target project capture policy has no valid rights object: ${error.message}`);
  }
}

function canRetainContent(policy) { return policyRights(policy).content === CONTENT_RIGHT; }
function canRetainMedia(policy) { return policyRights(policy).media === MEDIA_RIGHT; }

function extractedTextPresent(mapping) {
  return [
    ...mapping.pages.flatMap((page) => page.candidates ?? []),
    ...(mapping.navigationCandidates ?? []),
  ].some((candidate) => (candidate.provenance?.textFields ?? []).some((field) => field.source === 'extracted'));
}

function requestedId(prefix, target, identity) {
  return `${prefix}_${sha(`${target}\0${identity}`, 18)}`;
}

function captureRequestTopic(plan) {
  const host = new URL(plan.source.targetUrl).hostname.replace(/^www\./, '');
  // Drop a conventional non-brand suffix when it is joined in a domain label
  // (zilbermanfilmfoundation.com -> zilberman), while retaining arbitrary
  // client labels verbatim otherwise.
  const first = host.split('.')[0].replace(/(?:filmfoundation|foundation|studio|site)$/i, '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
  if (!first) throw new EmissionError('Capture source URL has no request-id-safe topic.');
  return first.slice(0, 48);
}

function captureRequestDate(plan) {
  const date = String(plan.source.mappingGeneratedAt ?? '').slice(0, 10).replaceAll('-', '');
  if (!/^\d{8}$/.test(date)) throw new EmissionError('Capture mapping generatedAt is not an ISO date.');
  return date;
}

export function captureRequestId(plan, pageRef) {
  const pages = plan.pageRefs ?? [];
  const ordinal = pages.indexOf(pageRef) + 1;
  if (ordinal < 1 || ordinal > 99) throw new EmissionError('Capture page has no bounded request-id ordinal.');
  return `req_capture_${captureRequestTopic(plan)}_${captureRequestDate(plan)}_${String(ordinal).padStart(2, '0')}`;
}

function templatePlans(mapping, target, threshold) {
  const grouped = new Map();
  for (const page of mapping.pages ?? []) {
    for (const candidate of page.candidates ?? []) {
      const key = candidate.sectionType;
      grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
    }
  }
  return [...grouped.entries()]
    .filter(([, candidates]) => candidates.length >= threshold)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sectionType, candidates]) => {
      const exemplar = clone(candidates[0].section);
      return {
        kind: 'section_template',
        objectType: 'section_template',
        requestedId: requestedId('stpl_capture', target, sectionType),
        idempotencyKey: `t12.4:${target}:section-template:${sha(sectionType)}`,
        reason: `shape repeated ${candidates.length} times (threshold ${threshold})`,
        body: {
          name: `Captured ${sectionType.replaceAll('_', ' ')} recipe`,
          description: `Draft recipe extracted from ${candidates.length} repeated ${sectionType} shapes.`,
          whenToUse: `Use for the repeated ${sectionType} shape discovered in this capture.`,
          scope: 'one_off',
          blueprint: exemplar,
        },
      };
    });
}

function createPlan(kind, objectType, target, requestedIdValue, body, reason) {
  return {
    kind,
    objectType,
    requestedId: requestedIdValue,
    idempotencyKey: `t12.4:${target}:${kind}:${sha(requestedIdValue)}`,
    body,
    reason,
  };
}

/** A stable, inspectable plan.  It contains no permissions inferred from CLI flags. */
export function buildEmissionPlan({ target, mapping, theme, repeatThreshold = 2 }) {
  if (!target || typeof target !== 'string') throw new EmissionError('A named target is required.');
  if (mapping?.schemaVersion !== 'capture-map.v1') throw new EmissionError('Emitter requires a capture-map.v1 mapping.');
  if (!theme?.name || !theme?.tokens) throw new EmissionError('Emitter requires a T12.3 theme draft.');
  const creates = [
    createPlan(
      'theme',
      'theme',
      target,
      requestedId('thm_capture', target, mapping.source?.targetUrl ?? mapping.generatedAt),
      clone(theme),
      'T12.3 bounded theme draft; draft only (site_apply_theme is intentionally absent).'
    ),
    ...templatePlans(mapping, target, repeatThreshold),
    ...(mapping.navigationCandidates ?? []).map((candidate) =>
      createPlan(
        'navigation',
        'navigation',
        target,
        requestedId('nav_capture', target, candidate.candidateId),
        clone(candidate.body),
        'Mapped navigation candidate.'
      )
    ),
    ...(mapping.pages ?? []).map((page) =>
      createPlan(
        'page',
        'page',
        target,
        requestedId('page_capture', target, page.pageRef),
        clone(page.pageBody),
        `Mapped page ${page.sourceUrl}; route availability is probed before creation.`
      )
    ),
  ];
  const media = (mapping.pages ?? []).flatMap((page) =>
    (page.candidates ?? []).flatMap((candidate) =>
      (candidate.assetBindings ?? []).map((asset) => ({ pageRef: page.pageRef, candidateId: candidate.candidateId, ...asset }))
    )
  );
  return {
    schemaVersion: 'capture-emission-plan.v1',
    task: 'T12.4',
    target,
    source: { mappingGeneratedAt: mapping.generatedAt, targetUrl: mapping.source?.targetUrl ?? null },
    pageRefs: (mapping.pages ?? []).map((page) => page.pageRef),
    repeatThreshold,
    copy: {
      source: 'target_project_contract',
      extractedTextPresent: extractedTextPresent(mapping),
      dryRunDisposition: 'policy_read_required_before_live_execution',
    },
    preflight: [
      { resolver: 'project_policy', arguments: { project_id: target }, purpose: 'exact project binding and capture policy (outside target MCP)' },
      { verb: 'object_inventory', arguments: { object_type: 'site', status: 'active' }, purpose: 'source-derived target site binding' },
      ...REQUIRED_TYPES.map((objectType) => ({ verb: 'object_contract', arguments: { object_type: objectType } })),
      { verb: 'object_inventory', arguments: { object_type: 'theme' }, purpose: 'reuse-first theme summaries' },
      { verb: 'object_inventory', arguments: { object_type: 'section_template' }, purpose: 'reuse-first recipe summaries' },
      { verb: 'object_inventory', arguments: { object_type: 'page' }, purpose: 'route-collision availability context' },
      { verb: 'object_get', arguments: { object_type: 'page', object_id: '<each inventory page id>' }, purpose: 'route-collision body probes when summaries omit routes' },
    ],
    creates,
    media,
    gaps: (mapping.pages ?? []).flatMap((page) => page.gaps ?? []),
    forbiddenVerbs: [...FORBIDDEN_VERBS].sort(),
  };
}

export const buildDryRunReport = (plan) => ({
  dryRun: true,
  plan,
  createdObjects: [],
  validationStates: [],
  quarantines: [],
  copyPolicy: plan.copy,
});

function responseContent(response) {
  if (response?.result?.isError) {
    const error = response.result.structuredContent ?? response.result.content ?? response.result;
    throw Object.assign(new EmissionError(error?.error ?? error?.message ?? 'MCP tool rejected the call.'), { response, error });
  }
  return response?.result?.structuredContent ?? response?.structuredContent ?? response?.result ?? response;
}

export function createMcpTransport({ endpoint, fetchImpl = fetch, token } = {}) {
  if (!endpoint) throw new EmissionError('MCP endpoint is required.');
  let sequence = 0;
  return {
    async call(verb, args) {
      if (FORBIDDEN_VERBS.has(verb)) throw new EmissionError(`Forbidden emission verb: ${verb}`);
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name: verb, arguments: args } }),
      });
      const parsed = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new EmissionError(`MCP HTTP ${response.status} for ${verb}.`), { status: response.status });
      return responseContent(parsed);
    },
  };
}

/** Bounded HTTPS probe for artifact metadata the target MCP requires. */
export function createAssetProbe({ fetchImpl = fetch, maxBytes = 5_000_000 } = {}) {
  return async (sourceUrl) => {
    const source = new URL(sourceUrl);
    if (source.protocol !== 'https:') throw new EmissionError('Artifact source must be HTTPS.');
    const response = await fetchImpl(sourceUrl, { redirect: 'follow' });
    if (!response.ok) throw new EmissionError(`Asset probe HTTP ${response.status}.`);
    const finalUrl = new URL(response.url || sourceUrl);
    // The capture manifest already authorizes this asset host. A redirect may
    // not silently switch origin while calculating the trusted hash/size.
    if (finalUrl.hostname !== source.hostname) throw new EmissionError('Asset probe redirected outside the source asset host.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new EmissionError('Asset exceeds the bounded probe limit.');
    const contentType = response.headers.get('content-type')?.split(';')[0].toLowerCase() ?? '';
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { sourceUrl: finalUrl.href, contentType, expectedSizeBytes: bytes.byteLength, expectedSha256: Buffer.from(digest).toString('hex') };
  };
}

function isAmbiguous(error) {
  return error?.status === 502 || error?.response?.status === 502 || /timeout|\b502\b/i.test(String(error?.message));
}
function errorCode(error) {
  return error?.error?.error_code ?? error?.response?.result?.structuredContent?.error_code ?? null;
}
function recordFrom(result) {
  const value = payload(result);
  return value?.record ?? value?.object ?? value;
}

function validationDecision(result, { precreate = false } = {}) {
  const value = payload(result);
  if (precreate && value?.id_available === false) return { valid: false, reason: 'requested_id_unavailable' };
  if (precreate && value?.singleton_conflict) return { valid: false, reason: 'singleton_conflict' };
  const eligible = value?.summary?.eligible ?? value?.eligible ?? value?.valid;
  if (eligible === true) return { valid: true, reason: null };
  if (eligible === false) {
    return {
      valid: false,
      reason: 'validation_blocked',
      blockers: value?.summary?.blockers ?? value?.errors ?? [],
    };
  }
  return { valid: false, reason: 'validation_eligibility_missing' };
}

async function callCreateWithRetry(transport, request, trace) {
  try {
    return await transport.call('object_create', request);
  } catch (error) {
    if (!isAmbiguous(error)) throw error;
    trace.push({ verb: 'object_create', retry: 'same_idempotency_key', idempotencyKey: request.idempotency_key });
    return transport.call('object_create', request);
  }
}

async function loadAdapter(modulePath) {
  if (!modulePath) return null;
  const module = await import(pathToFileURL(path.resolve(modulePath)).href);
  if (typeof module.regenerateBody !== 'function')
    throw new EmissionError('Model adapter must export async regenerateBody({ body, objectType, target, source }).');
  return module;
}

function policySummary(policy, adapter) {
  if (canRetainContent(policy))
    return { mode: 'keep_extracted', source: 'target_project_contract' };
  if (!adapter) throw new EmissionError('Target contract does not allow extracted copy; provide an explicit --model-adapter to regenerate it.');
  return { mode: 'regenerate', source: 'target_project_contract', adapter: 'explicit' };
}

async function ensureContracts(transport, trace) {
  const contracts = {};
  for (const objectType of REQUIRED_TYPES) {
    const contract = await transport.call('object_contract', { object_type: objectType });
    const value = payload(contract);
    contracts[objectType] = value.contract ?? value;
    trace.push({ verb: 'object_contract', objectType });
  }
  return contracts;
}

function creationAllowed(contract) {
  const policy = contract?.creation_policy ?? {};
  return policy.agents === 'open' || policy.agents?.allowlist?.includes('t12.4-emitter') === true;
}

function inventoryRows(result) {
  const value = payload(result);
  return value?.objects ?? value?.items ?? value?.inventory?.objects ?? [];
}
function recipeName(row) { return row?.recipe?.name ?? row?.recipe_summary?.name ?? row?.recipeSummary?.name ?? row?.body?.name ?? null; }
function routeOf(row) { return row?.route ?? row?.body?.route ?? row?.page?.route ?? null; }
function unpublished(record) {
  const publication = record?.publication ?? record?.record?.publication;
  return publication?.published_time === null || record?.published_time === null;
}

function artifactKindForCapture(kind) {
  if (kind === 'image') return 'image';
  if (kind === 'document') return 'doc';
  return null;
}

async function pageRouteRows(transport, inventory, trace) {
  const rows = inventoryRows(inventory);
  const resolved = [];
  for (const row of rows) {
    if (routeOf(row)) {
      resolved.push(row);
      continue;
    }
    if (typeof row?.object_id !== 'string') throw new EmissionError('Page inventory row has no object_id for route probing.');
    const detail = await transport.call('object_get', { object_type: 'page', object_id: row.object_id });
    trace.push({ verb: 'object_get', objectType: 'page', objectId: row.object_id, purpose: 'route_collision_probe' });
    const record = recordFrom(detail);
    if (!routeOf(record)) throw new EmissionError(`Page ${row.object_id} has no readable route for collision probing.`);
    resolved.push(record);
  }
  return resolved;
}

/**
 * Execute a plan through an injected MCP transport.  Used by the CLI and by
 * the integration tests; it never imports core store modules.
 */
export async function executeEmission({ plan, transport, projectPolicyResolver, modelAdapter = null, assetProbe = null }) {
  if (!transport?.call) throw new EmissionError('An MCP transport is required for live emission.');
  if (typeof projectPolicyResolver !== 'function') throw new EmissionError('A project-policy resolver is required before target MCP calls.');
  const trace = [];
  // This MUST precede every target MCP call. The CMS-Agent project registry
  // owns capture governance; per-site MCP intentionally does not expose it.
  const project = await projectPolicyResolver(plan.target);
  trace.push({ resolver: 'project_policy', target: plan.target });
  const capturePolicy = capturePolicyFromProject(project, plan.target);
  const copyPolicy = policySummary(capturePolicy, modelAdapter);
  const siteInventory = await transport.call('object_inventory', { object_type: 'site', status: 'active' });
  trace.push({ verb: 'object_inventory', objectType: 'site', purpose: 'derive_site_binding' });
  const sites = inventoryRows(siteInventory).filter((row) => row.object_type === 'site' && row.status === 'active');
  if (sites.length !== 1 || typeof sites[0].object_id !== 'string')
    throw new EmissionError('Target MCP must expose exactly one active site object for emission binding.');
  const siteId = sites[0].object_id;
  const contracts = await ensureContracts(transport, trace);
  const inventories = {};
  for (const type of ['theme', 'section_template', 'page']) {
    inventories[type] = await transport.call('object_inventory', { object_type: type });
    trace.push({ verb: 'object_inventory', objectType: type });
  }
  const existingPages = await pageRouteRows(transport, inventories.page, trace);
  const report = {
    ...plan,
    dryRun: false,
    siteId,
    copyPolicy,
    createdObjects: [],
    reusedObjects: [],
    createdArtifacts: [],
    validationStates: [],
    quarantines: [],
    gapReportRefs: plan.gaps,
    trace,
  };

  for (const operation of plan.creates) {
    if (FORBIDDEN_VERBS.has(operation.verb)) throw new EmissionError('Plan attempted a forbidden verb.');
    const contract = contracts[operation.objectType];
    if (!creationAllowed(contract)) {
      report.quarantines.push({ requestedId: operation.requestedId, reason: 'creation_restricted', objectType: operation.objectType });
      continue;
    }
    const existingRecipes = inventoryRows(inventories[operation.objectType]);
    const reusable = ['theme', 'section_template'].includes(operation.objectType)
      ? existingRecipes.find((row) => recipeName(row) === operation.body.name)
      : null;
    if (reusable) {
      report.reusedObjects.push({
        objectType: operation.objectType,
        objectId: reusable.object_id ?? null,
        name: operation.body.name,
        reason: 'matching_recipe_summary',
      });
      continue;
    }
    if (operation.objectType === 'page' && existingPages.some((row) => routeOf(row) === operation.body.route)) {
      report.quarantines.push({ requestedId: operation.requestedId, reason: 'route_collision', route: operation.body.route });
      continue;
    }
    let body = clone(operation.body);
    if (copyPolicy.mode === 'regenerate' && operation.objectType !== 'theme') {
      body = await modelAdapter.regenerateBody({ body, objectType: operation.objectType, target: plan.target, source: plan.source });
      if (!body || typeof body !== 'object') throw new EmissionError('Model adapter returned no replacement body.');
    }
    const candidate = { object_type: operation.objectType, body, requested_id: operation.requestedId };
    let createdObjectId = null;
    try {
      // Contract-required candidate validation against the exact deterministic
      // id that object_create will use. This catches both body blockers and id
      // collisions without creating anything.
      const candidateValidation = await transport.call('object_validate', {
        object_type: operation.objectType,
        requested_id: operation.requestedId,
        body,
      });
      trace.push({ verb: 'object_validate', phase: 'precreate', requestedId: operation.requestedId });
      const candidateDecision = validationDecision(candidateValidation, { precreate: true });
      report.validationStates.push({
        phase: 'precreate',
        requestedId: operation.requestedId,
        valid: candidateDecision.valid,
        reason: candidateDecision.reason,
      });
      if (!candidateDecision.valid) throw new EmissionError(`candidate validation failed: ${candidateDecision.reason}`);
      const created = await callCreateWithRetry(
        transport,
        { ...candidate, site: siteId, idempotency_key: operation.idempotencyKey, agent_name: 't12.4-emitter' },
        trace
      );
      trace.push({ verb: 'object_create', requestedId: operation.requestedId, idempotencyKey: operation.idempotencyKey });
      const record = recordFrom(created);
      const objectId = record.object_id ?? operation.requestedId;
      createdObjectId = objectId;
      const draftVerified = unpublished(record);
      report.createdObjects.push({
        objectType: operation.objectType,
        objectId,
        draftVerified,
        ...(draftVerified ? { published_time: null } : {}),
      });
      if (!draftVerified) {
        report.quarantines.push({ objectId, reason: 'not_draft_only_response' });
        continue;
      }
      const validation = await transport.call('object_validate', { object_type: operation.objectType, object_id: objectId });
      trace.push({ verb: 'object_validate', phase: 'postcreate', objectId });
      const decision = validationDecision(validation);
      report.validationStates.push({ phase: 'postcreate', objectId, valid: decision.valid, reason: decision.reason });
      if (!decision.valid) {
        report.quarantines.push({ objectId, objectType: operation.objectType, reason: 'postcreate_validation_failed' });
      }
    } catch (error) {
      const reason = errorCode(error) === 'creation_restricted' ? 'creation_restricted' : 'validation_or_create_failed';
      report.quarantines.push({
        ...(createdObjectId ? { objectId: createdObjectId } : { requestedId: operation.requestedId }),
        objectType: operation.objectType,
        reason,
        error: String(error.message),
      });
    }
  }

  // Artifact ingestion is optional and only runs when the target policy says
  // media rights allow it AND the map supplies verified URL metadata.  No
  // placeholder URLs, portable:false references, or fabricated checksums.
  if (canRetainMedia(capturePolicy)) {
    const probe = assetProbe ?? createAssetProbe();
    const seen = new Set();
    let lastAssetStartedAt = 0;
    const assetDelayMs = Number.isInteger(capturePolicy.delayMs) && capturePolicy.delayMs >= 0 ? capturePolicy.delayMs : 0;
    for (const asset of plan.media) {
      if (seen.has(asset.manifestRef)) continue;
      seen.add(asset.manifestRef);
      const artifactKind = artifactKindForCapture(asset.kind);
      if (!artifactKind) { report.quarantines.push({ asset: asset.manifestRef, reason: 'unsupported_media_kind' }); continue; }
      const remainingDelay = assetDelayMs - (Date.now() - lastAssetStartedAt);
      if (remainingDelay > 0) await new Promise((resolve) => setTimeout(resolve, remainingDelay));
      lastAssetStartedAt = Date.now();
      let resolved = asset;
      if (!asset.contentType || !Number.isInteger(asset.expectedSizeBytes) || !/^[a-f0-9]{64}$/i.test(asset.expectedSha256 ?? '')) {
        resolved = { ...asset, ...(await probe(asset.sourceUrl)) };
      }
      if (
        !resolved.contentType ||
        (artifactKind === 'image' && !resolved.contentType.startsWith('image/')) ||
        !Number.isInteger(resolved.expectedSizeBytes) ||
        !/^[a-f0-9]{64}$/i.test(resolved.expectedSha256 ?? '')
      ) {
        report.quarantines.push({ asset: asset.manifestRef, reason: 'artifact_metadata_missing' }); continue;
      }
      try {
        const requestId = captureRequestId(plan, asset.pageRef);
        const artifact = await transport.call('create_artifact_from_url', {
          requestId,
          artifactKind, contentType: resolved.contentType, sourceUrl: resolved.sourceUrl,
          expectedSizeBytes: resolved.expectedSizeBytes, expectedSha256: resolved.expectedSha256,
        });
        const value = payload(artifact);
        report.createdArtifacts.push({ manifestRef: asset.manifestRef, requestId, artifact: value.artifact ?? value });
        trace.push({ verb: 'create_artifact_from_url', asset: asset.manifestRef });
      } catch (error) { report.quarantines.push({ asset: asset.manifestRef, reason: 'artifact_ingest_failed', error: String(error.message) }); }
    }
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [mapping, theme] = await Promise.all([readFile(path.resolve(args.mapping), 'utf8'), readFile(path.resolve(args.theme), 'utf8')]);
  const plan = buildEmissionPlan({ target: args.target, mapping: JSON.parse(mapping), theme: JSON.parse(theme), repeatThreshold: args.repeatThreshold });
  if (args.dryRun) {
    const report = buildDryRunReport(plan);
    if (args.out) await writeFile(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const policyResponse = JSON.parse(await readFile(path.resolve(args['project-policy']), 'utf8'));
  const report = await executeEmission({
    plan,
    mapping: JSON.parse(mapping),
    transport: createMcpTransport({ endpoint: args.endpoint, token: process.env.MCP_HTTP_AUTH_TOKEN }),
    projectPolicyResolver: async (projectId) => {
      if (targetId(policyResponse) !== projectId) throw new EmissionError(`Project-policy file does not bind ${projectId}.`);
      return policyResponse;
    },
    modelAdapter: await loadAdapter(args['model-adapter']),
  });
  if (args.out) await writeFile(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
