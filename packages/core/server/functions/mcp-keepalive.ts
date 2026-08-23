/**
 * MCP + admin-read keep-warm and latency telemetry (scheduled function).
 *
 * The /mcp endpoint is a synchronous serverless function: after ~5-15 idle
 * minutes its runtime instance is reclaimed and the next agent call pays a
 * cold start (bundle load + native sharp binding) that can be slow enough for
 * MCP clients to time out their initialize handshake — the intermittent
 * "cannot connect" symptom. This function probes /mcp on a schedule (declared
 * in netlify.toml) so at least one warm instance is always available, and
 * logs a structured latency line per probe, turning the Netlify function log
 * into a free latency/availability monitor.
 *
 * Probe modes:
 *  - With MCP_HTTP_AUTH_TOKEN in the environment (the server's own expected
 *    token — it never leaves the server side): POST tools/call ping, which
 *    exercises the full auth + JSON-RPC + tool dispatch path.
 *  - Without it: GET /mcp?health=1, the unauthenticated liveness probe.
 *
 * The admin read path (admin-object, admin-audit — the functions behind
 * /admin/content) has the same cold-start problem: measured TTFB was 1.61s
 * cold vs 0.33s warm on the unauthenticated 401 path alone (pure bundle-load
 * cost, before any blob-store I/O). Both functions call
 * resolveAdminAccessFromEvent (packages/core/server/lib/request-roles.ts)
 * FIRST and return 401 immediately when no Authorization header/token is
 * present — getAdminStateFromEvent (admin-auth.ts) short-circuits on no
 * bearer token without any network or store call — so an unauthenticated
 * POST warms the function's bundle/runtime without touching real data or
 * making the identity round trip. A 401 on these probes is therefore the
 * EXPECTED, successful outcome; anything else (2xx, 5xx, network failure) is
 * an anomaly worth flagging in the logs.
 *
 * Scheduled functions run only on the published production deploy. Set
 * MCP_KEEPALIVE_DISABLED=true to turn probing off without a code change;
 * MCP_KEEPALIVE_TARGET_URL overrides the probed site URL (defaults to the
 * Netlify-provided URL env).
 *
 * Admin-warming scope (deliberate, not an oversight): this handler is fleet
 * law — every other site under sites/* wires the SAME `createHandler` with
 * its own SiteBinding, its own every-5-minutes netlify.toml schedule, and
 * (for at least two of them, checked at the time of writing) structurally
 * identical admin-object/admin-audit functions, so a naive unconditional
 * change here would have silently started warming every site's admin path
 * too. Only one site was profiled (the 1.61s/0.33s numbers), so admin
 * warming is gated on `binding.warmAdminKeepalive` — a plain per-site data
 * field a site opts into from its OWN `config/site-binding.ts` (see
 * SiteBinding in ../lib/site-binding.js) — rather than this fleet-law file
 * branching on a site's identity. packages/core carries zero site-name
 * literals by lint (tests/scripts/core-no-site-literals.test.mjs); this seam
 * keeps that true while still letting one site opt in unilaterally.
 */
import type { SiteBinding } from '../lib/site-binding.js';

const PROBE_TIMEOUT_MS = 8_000;

/** Admin functions warmed alongside /mcp — the read path behind /admin/content. */
const ADMIN_KEEPALIVE_TARGETS = ['admin-object', 'admin-audit'] as const;
type AdminKeepaliveTarget = (typeof ADMIN_KEEPALIVE_TARGETS)[number];

type ProbeResult = {
  ok: boolean;
  mode: 'skipped' | 'ping_tool' | 'health_get';
  httpStatus?: number;
  latencyMs?: number;
  instanceAgeMs?: number;
  coldStartSuspected?: boolean;
  error?: string;
  reason?: string;
};

const readInstanceAgeMs = (payload: unknown): number | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;

  if (typeof record.instance_age_ms === 'number') return record.instance_age_ms;

  // ping tool result: { result: { structuredContent: { instance_age_ms } } }
  const result = record.result as Record<string, unknown> | undefined;
  const structured = result?.structuredContent as Record<string, unknown> | undefined;
  return typeof structured?.instance_age_ms === 'number' ? structured.instance_age_ms : undefined;
};

export const runKeepaliveProbe = async (
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env
): Promise<ProbeResult> => {
  if ((env.MCP_KEEPALIVE_DISABLED ?? '').trim().toLowerCase() === 'true') {
    return { ok: true, mode: 'skipped', reason: 'MCP_KEEPALIVE_DISABLED' };
  }

  const base = (env.MCP_KEEPALIVE_TARGET_URL ?? env.URL ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    return { ok: false, mode: 'skipped', reason: 'no target URL (URL / MCP_KEEPALIVE_TARGET_URL unset)' };
  }

  const token = (env.MCP_HTTP_AUTH_TOKEN ?? '').trim();
  const mode: ProbeResult['mode'] = token ? 'ping_tool' : 'health_get';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const probeResponse = token
      ? await fetchImpl(`${base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mcp-auth-token': token },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'keepalive',
            method: 'tools/call',
            params: { name: 'ping', arguments: {} },
          }),
          signal: controller.signal,
        })
      : await fetchImpl(`${base}/mcp?health=1`, { method: 'GET', signal: controller.signal });

    const latencyMs = Date.now() - startedAt;
    let instanceAgeMs: number | undefined;

    try {
      instanceAgeMs = readInstanceAgeMs(await probeResponse.json());
    } catch {
      // Non-JSON body — latency and status are still worth reporting.
    }

    return {
      ok: probeResponse.ok,
      mode,
      httpStatus: probeResponse.status,
      latencyMs,
      instanceAgeMs,
      // A young instance answering slowly = the probe itself paid the cold
      // start; that is the keep-warm doing its job, but flag it so cold-start
      // frequency stays visible in the logs.
      coldStartSuspected: instanceAgeMs !== undefined && instanceAgeMs < 5_000,
    };
  } catch (error) {
    return {
      ok: false,
      mode,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
};

type AdminProbeResult = {
  ok: boolean;
  target: AdminKeepaliveTarget;
  mode: 'skipped' | 'unauthenticated_probe';
  httpStatus?: number;
  latencyMs?: number;
  error?: string;
  reason?: string;
};

/**
 * Warms one admin read function via a deliberately unauthenticated POST. No
 * Authorization header is sent, so resolveAdminAccessFromEvent rejects the
 * request in getAdminStateFromEvent before any blob-store call — see the
 * file header for the full trace. 401 is success (bundle/runtime warmed,
 * cheaply); anything else is logged as an anomaly rather than thrown.
 */
export const runAdminKeepaliveProbe = async (
  target: AdminKeepaliveTarget,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env
): Promise<AdminProbeResult> => {
  if ((env.MCP_KEEPALIVE_DISABLED ?? '').trim().toLowerCase() === 'true') {
    return { ok: true, target, mode: 'skipped', reason: 'MCP_KEEPALIVE_DISABLED' };
  }

  const base = (env.MCP_KEEPALIVE_TARGET_URL ?? env.URL ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    return { ok: false, target, mode: 'skipped', reason: 'no target URL (URL / MCP_KEEPALIVE_TARGET_URL unset)' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const probeResponse = await fetchImpl(`${base}/.netlify/functions/${target}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });

    return {
      // No Authorization header was sent, so 401 is the expected, healthy
      // outcome — it means the function warmed and the auth gate ran.
      ok: probeResponse.status === 401,
      target,
      mode: 'unauthenticated_probe',
      httpStatus: probeResponse.status,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      target,
      mode: 'unauthenticated_probe',
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
};

const buildHandlerImpl = (binding: SiteBinding) => async () => {
  // Gated per "Admin-warming scope" in the file header — opt-in per site.
  const adminTargets = binding.warmAdminKeepalive ? ADMIN_KEEPALIVE_TARGETS : [];

  const [mcpResult, ...adminResults] = await Promise.all([
    runKeepaliveProbe(),
    ...adminTargets.map((target) => runAdminKeepaliveProbe(target)),
  ]);

  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'mcp_keepalive_probe', ...mcpResult }));
  for (const adminResult of adminResults) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'admin_keepalive_probe', ...adminResult }));
  }

  const ok = mcpResult.ok && adminResults.every((result) => result.ok);

  return {
    statusCode: ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok, mcp: mcpResult, admin: adminResults }),
  };
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
