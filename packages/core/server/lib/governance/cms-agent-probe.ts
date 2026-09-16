/**
 * M3.4 — the CMS-Agent health probe, and the one module in this repo allowed
 * to make it.
 *
 * ## Where it came from, and why it moved
 *
 * It lived in `functions/admin-governance.ts`, on the `get` verb, behind a
 * module-scope 60 s memo. Measured on `/admin/visual-identity`:
 * `governance` 3.9 s with `sec.probe = 2768`. The memo is not a defence — it
 * is per instance, Netlify runs many, and a cold container starts with an
 * empty map by construction, which is why the very next measurement of the
 * same function on `/admin/guardrails` read `work = 109`. Wave 1 named that
 * shape the memo lottery and removed it from the release overview for exactly
 * this reason.
 *
 * So the probe is no longer reachable from a page path at all. It is called
 * by `functions/governance-probe-refresh.ts` on a five-minute schedule, and
 * its result is stored in `snapshots/governance.json`
 * (`governance/snapshot-store.ts`). Pages read the blob.
 *
 * The 60 s memo is GONE with it, deliberately: a scheduled caller that runs
 * once every five minutes has nothing to de-duplicate, and a memo whose only
 * remaining effect would be to let a pass serve a result it did not take is a
 * lie about `checked_at`.
 */
import { CmsAgentClient, cmsAgentMissingEnvVars } from '../agent/cms-agent-client.js';
import { getSiteIdentity } from '../../../lib/site-identity.js';
import type { SiteBinding } from '../site-binding.js';
import type { CmsAgentProbeResult } from './snapshot-view.js';

/**
 * The budget, carried over unchanged from `admin-governance.ts` and for the
 * reason it was set there: `CmsAgentClient`'s default is a
 * conversational-turn 90 s per call, and a probe may need up to three SERIAL
 * calls (`initialize`, `notifications/initialized`, `tools/call` for
 * `agent_resolve`). A live turn can legitimately need that; a status check
 * cannot. 3 s is generous for a same-region, no-payload health call and
 * bounds the worst case — a lost session forcing a fresh handshake — to
 * single-digit seconds.
 *
 * It matters slightly LESS now than it did (nobody is waiting on it), and
 * slightly MORE in one respect: this runs on a schedule across six tenants,
 * so an unbounded probe is an unbounded scheduled-function bill. Scoped to
 * THIS client instance; every other `CmsAgentClient` caller keeps the 90 s
 * default.
 */
export const CMS_AGENT_PROBE_TIMEOUT_MS = 3_000;

/**
 * A FRESH client per pass, and that is the point of the probe.
 *
 * `CmsAgentClient` memoises a resolved `agent_ref` for `AGENT_REF_TTL_MS`
 * (five minutes) and reuses its MCP session. A module-scope instance called
 * on a five-minute schedule would therefore answer `reachable: true` out of
 * its own cache, without a packet leaving the function, for as long as the
 * container lived — a green light that says nothing about whether CMS-Agent
 * is up. That is the same class of mistake as the 60 s memo this milestone
 * deleted, one layer down.
 *
 * So each pass pays a real handshake: `initialize`,
 * `notifications/initialized`, `tools/call` for `agent_resolve` — three
 * serial calls, bounded together by `CMS_AGENT_PROBE_TIMEOUT_MS`, and the
 * `latency_ms` this module reports is all three. A health check that reuses a
 * session is not a health check.
 */
const newProbeClient = () => new CmsAgentClient({ timeoutMs: CMS_AGENT_PROBE_TIMEOUT_MS });

/**
 * Which env vars this tenant is missing for CMS-Agent. NAMES only, never
 * values — and no network, which is why a page can still answer `configured`
 * off the snapshot without anybody having probed.
 */
export const cmsAgentConfigurationGap = (binding: SiteBinding): string[] => cmsAgentMissingEnvVars(binding.env);

/**
 * Take a probe. Never throws: every failure — unconfigured, timed out,
 * refused, protocol error — is a RESULT, because a scheduled pass that threw
 * would leave the snapshot carrying an older answer with no record that the
 * service had stopped answering.
 *
 * `latency_ms` is measured end to end around the whole call, handshake
 * included: a probe that is slow because the session was lost is slow, and
 * splitting that out would hide the number worth watching.
 */
export const probeCmsAgent = async (binding: SiteBinding, nowMs: number = Date.now()): Promise<CmsAgentProbeResult> => {
  const checkedAt = new Date(nowMs).toISOString();
  const missing = cmsAgentConfigurationGap(binding);
  if (missing.length > 0) {
    return {
      checked_at: checkedAt,
      reachable: false,
      latency_ms: 0,
      agent_ref: null,
      code: 'cms_agent_not_configured',
      message: `Missing environment: ${missing.join(', ')}.`,
    };
  }

  const startedAt = Date.now();
  try {
    const probe = await newProbeClient().resolveAgent({
      role: 'client_manager',
      project_id: getSiteIdentity().cmsAgentProjectId,
    });
    const latencyMs = Math.max(0, Date.now() - startedAt);
    return probe.ok
      ? {
          checked_at: checkedAt,
          reachable: true,
          latency_ms: latencyMs,
          agent_ref: probe.data.agent_ref,
          code: null,
          message: null,
        }
      : {
          checked_at: checkedAt,
          reachable: false,
          latency_ms: latencyMs,
          agent_ref: null,
          code: probe.code,
          message: probe.message,
        };
  } catch (error) {
    return {
      checked_at: checkedAt,
      reachable: false,
      latency_ms: Math.max(0, Date.now() - startedAt),
      agent_ref: null,
      code: 'cms_agent_error',
      message: error instanceof Error ? error.message : 'The probe failed.',
    };
  }
};
