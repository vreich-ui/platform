/**
 * Function name: Governance_Probe_Refresh (M3.4) — scheduled, every five
 * minutes at minutes 4, 9, 14 … 59.
 *
 * The reason `snapshots/governance.json` can carry a CMS-Agent verdict at all.
 *
 * M3.4 moved the CMS-Agent health probe off the page path. It used to run on
 * `admin-governance`'s `get` verb, which is what `/admin/guardrails` and
 * `/admin/visual-identity` both call on load: measured `governance` 3.9 s with
 * `sec.probe = 2768` on visual identity, and `work = 109` two minutes later on
 * guardrails — the memo lottery, not a fix (the memo is module scope and a
 * cold container starts without it). The document half of that response is
 * written by the three governance write paths; nothing in this repo observes
 * CMS-Agent going down or coming back. So the probe needs a clock, and this
 * is it.
 *
 * Five minutes because the probe's whole value is as a recent reading, and
 * because `CMS_AGENT_PROBE_MAX_AGE_MS` (fifteen minutes, three missed passes)
 * is calibrated against it: past that bound a reader renders "last checked
 * hh:mm" instead of a live-looking verdict, so an outage of THIS function
 * degrades to a stated timestamp rather than to a wrong green dot. It never
 * degrades to a page that probes — no read path in this repo can reach
 * `governance/cms-agent-probe.ts`.
 *
 * Minute offset 4, not `*\/5`: `mcp-keepalive` and `editorial-request-sweep`
 * already hold `*\/5 * * * *` on every tenant and fire at minutes 0, 5, 10 …,
 * and `object-index-rebuild` holds minute 23. `4-59/5` is the same cadence
 * with none of those minutes. It still shares six minutes an hour with
 * `release-snapshot-refresh`'s `*\/2`, which no five-minute schedule can
 * avoid — stating it beats pretending otherwise.
 *
 * ## Invocation cost — stated, per KNOWN_ISSUES #72
 *
 * 12 firings per hour x 24 = **288 invocations per tenant per day**, and the
 * fleet is six tenants (root/drlurie plus the five `sites/*`), so **1,728
 * scheduled invocations per day** are added by this function alone. Each pass
 * is: one CMS-Agent probe (up to three serial HTTP calls, hard-capped at
 * `CMS_AGENT_PROBE_TIMEOUT_MS` = 3 s), one blob read of `overrides.v1`, and
 * one blob write. So it also adds **1,728 CMS-Agent probes per day**
 * fleet-wide — a number that did not exist as a line item before, because it
 * used to be charged to whoever opened an admin page on a cold instance.
 *
 * What it removes is larger and was paid by people rather than by a schedule:
 * every `/admin/guardrails` and `/admin/visual-identity` load on a cold
 * container paid up to 3 s of probe, on the page path, per view.
 *
 * Declared per site in netlify.toml (`[functions."governance-probe-refresh"]
 * schedule = "4-59/5 * * * *"`) — a scheduled function only runs if its
 * schedule is DECLARED (P1: every `sites/<client>/netlify.toml` carries the
 * block, and so does the `create-site.mjs` scaffold).
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getGovernanceBlobStore } from '../lib/governance-store.js';
import { probeCmsAgent } from '../lib/governance/cms-agent-probe.js';
import { refreshGovernanceProbeSnapshot } from '../lib/governance/snapshot-store.js';

export const runGovernanceProbeRefresh = async (event: unknown, nowMs = Date.now(), binding?: SiteBinding) => {
  if (!binding) throw new Error('governance-probe-refresh requires a SiteBinding.');
  const store = await getGovernanceBlobStore(event, binding);
  const probe = await probeCmsAgent(binding, nowMs);
  const { snapshot, written } = await refreshGovernanceProbeSnapshot(store, probe, nowMs);
  return {
    ok: true,
    at: snapshot.as_of,
    written,
    /** The number an operator should watch. Persistently false is an outage, not a blip. */
    reachable: probe.reachable,
    latency_ms: probe.latency_ms,
    code: probe.code,
    /** True when this tenant has never had CMS-Agent credentials — a configuration state, not a fault. */
    unconfigured: probe.code === 'cms_agent_not_configured',
    overrides_present: snapshot.doc !== null,
  };
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: unknown) => {
  try {
    const result = await runGovernanceProbeRefresh(event, Date.now(), binding);
    console.log(JSON.stringify({ ts: result.at, event: 'governance_probe_refresh', ...result }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Governance probe refresh failed.', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false }) };
  }
};

/** Per-site factory — the site shim instantiates this with its binding (the `membership-sweep` pattern). */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
