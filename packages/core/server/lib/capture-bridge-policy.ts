/**
 * T12.13 — the capture bridge's OWN half of "bounds are enforced on BOTH sides".
 *
 * The single operational source of capture bounds is the CMS-Agent project registry's
 * `ProjectCapturePolicy` (ruling R-C2 v2, 2026-08-13: duplicating the policy in a second home
 * is drift risk for zero capability, so a tenant does NOT store its own copy). The policy
 * therefore travels with the call: registry (CMS-Agent) -> this bridge -> pdf-tool's worker,
 * which re-validates it from the stored job record on every invocation.
 *
 * That makes THIS module the middle enforcement point, and its job is precisely bounded:
 *
 *  - it may never WIDEN anything. The four T12 invariants (`sameOriginOnly`,
 *    `respectRobots`, `authenticatedAccess: "prohibited"`, and a `maxPages` the project
 *    actually raised off the registry's deny-all floor) are refused here, not merely relayed;
 *  - `maxPages` is CLAMPED to CAPTURE_BRIDGE_MAX_PAGES — mirroring pdf-tool's own
 *    HARD_MAX_CAPTURE_PAGES_PER_JOB, so a caller asking for 10 000 pages gets 50 whichever
 *    side you ask;
 *  - the seed URL must sit inside the policy the same call carries, so a caller cannot pair a
 *    tight policy with an out-of-bounds seed;
 *  - it deliberately does NOT reimplement pdf-tool's full `parseCapturePolicy`. The complete
 *    shape gate (strict unknown-field refusal, per-field bounds, designReferences literals,
 *    fidelity enums) stays exactly where the crawl happens, single-sourced. What this module
 *    adds is a REQUIRED-BLOCK check — `rights`, `designReferences` and `fidelity` must all be
 *    present — so the T12.9 defect (a caller sending a policy SUBSET that only pdf-tool's
 *    parser rejects, three hops away) fails here with a bridge-side error code instead.
 *
 * Nothing in this module reads or emits a credential: the capture plane holds none (see the
 * capture bridge handlers in mcp-tool-handlers.ts, and pdf-tool's lib/capture/storage.ts).
 */

/** Mirrors pdf-tool's HARD_MAX_CAPTURE_PAGES_PER_JOB (netlify/lib/capture/policy.ts). */
export const CAPTURE_BRIDGE_MAX_PAGES = 50;

export type CaptureBridgePolicyResult =
  | { ok: true; policy: Record<string, unknown>; effectiveMaxPages: number; clamped: boolean }
  | { ok: false; error: string; errorCode: 'capture_policy_invalid' | 'capture_policy_denies' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const invalid = (error: string): CaptureBridgePolicyResult => ({
  ok: false,
  error,
  errorCode: 'capture_policy_invalid',
});

const denies = (error: string): CaptureBridgePolicyResult => ({
  ok: false,
  error,
  errorCode: 'capture_policy_denies',
});

const isHttpsOrigin = (value: unknown): boolean => {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
};

const isPathPrefix = (value: unknown): boolean => typeof value === 'string' && /^\/(?!\/)[^?#]*$/.test(value);

export const validateCaptureBridgePolicy = (input: unknown): CaptureBridgePolicyResult => {
  if (!isRecord(input)) return invalid('policy must be an object carrying the project registry capturePolicy.');

  for (const block of ['rights', 'designReferences', 'fidelity'] as const) {
    const value = input[block];
    const present = block === 'designReferences' ? Array.isArray(value) : isRecord(value);
    if (!present) {
      return invalid(
        `policy.${block} is required: forward the project registry's capturePolicy VERBATIM (a subset is refused here rather than three hops away).`
      );
    }
  }

  const { maxPages, allowedCrawlOrigins, allowedPathPrefixes } = input;
  if (typeof maxPages !== 'number' || !Number.isSafeInteger(maxPages) || maxPages < 0) {
    return invalid('policy.maxPages must be a non-negative integer.');
  }
  if (!Array.isArray(allowedCrawlOrigins) || !allowedCrawlOrigins.every(isHttpsOrigin)) {
    return invalid('policy.allowedCrawlOrigins must be an array of HTTPS origins with no path, query, or fragment.');
  }
  if (!Array.isArray(allowedPathPrefixes) || !allowedPathPrefixes.every(isPathPrefix)) {
    return invalid('policy.allowedPathPrefixes must be an array of absolute path prefixes without query or fragment.');
  }

  // Refusals below are the ceilings themselves: this bridge is structurally incapable of
  // relaxing any of them, so a caller cannot buy authority by shaping its arguments.
  if (maxPages < 1) {
    return denies(
      'policy.maxPages is 0: this project denies all capture (the registry default). Raise it on the project record, not here.'
    );
  }
  if (allowedCrawlOrigins.length === 0) return denies('policy.allowedCrawlOrigins must contain at least one origin.');
  if (allowedPathPrefixes.length === 0)
    return denies('policy.allowedPathPrefixes must contain at least one path prefix.');
  if (input.sameOriginOnly !== true) return denies('The capture plane requires sameOriginOnly=true.');
  if (input.respectRobots !== true) return denies('The capture plane requires respectRobots=true.');
  if (input.authenticatedAccess !== 'prohibited') {
    return denies('The capture plane requires authenticatedAccess="prohibited".');
  }

  const effectiveMaxPages = Math.min(maxPages, CAPTURE_BRIDGE_MAX_PAGES);
  return {
    ok: true,
    // Clamped, never widened: what leaves here can only ever authorize LESS than what came in.
    policy: { ...input, maxPages: effectiveMaxPages },
    effectiveMaxPages,
    clamped: effectiveMaxPages < maxPages,
  };
};

export type CaptureSeedUrlResult = { ok: true; url: string } | { ok: false; error: string };

/** The seed must be HTTPS and inside the very policy this call carries. */
export const validateCaptureSeedUrl = (raw: string, policy: Record<string, unknown>): CaptureSeedUrlResult => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `url is not a valid URL: ${raw}` };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'url must be HTTPS.' };
  url.hash = '';
  const origins = policy.allowedCrawlOrigins as string[];
  const prefixes = policy.allowedPathPrefixes as string[];
  if (!origins.includes(url.origin) || !prefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    return {
      ok: false,
      error: `url ${url.href} is outside the supplied capture policy (allowed origins: ${origins.join(', ')}; path prefixes: ${prefixes.join(', ')}). Origins and prefixes are ceilings; a caller cannot widen them.`,
    };
  }
  return { ok: true, url: url.href };
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// W21 (Wolf, 2026-09-14) — THE PER-SITE CAPTURE GUARDRAIL.
//
// Where the registry decides WHAT a project may crawl, this decides how much of that authority
// the SITE is currently willing to use. It is the capture plane's equivalent of
// `brandImageryOverrides`: an Owner-set mode on the governance doc, editable from
// /admin/settings/guardrails with no deploy and no registry write.
//
// It fits the module's one rule — this bridge may never widen — because every mode is a filter
// over the policy the call already carried. There is no mode that adds an origin, raises
// maxPages, or relaxes an invariant, and there is deliberately no way to express one.
//
// `open` is the default because an unset guardrail must mean "as the registry decided", not "off":
// a tenant nobody has visited the guardrails page for behaves exactly as it did before this
// existed, and the safety story stays where it belongs — the registry's origin allowlist, the
// three-sided invariants above, and pdf-tool's own re-validation.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type SiteCaptureMode = 'open' | 'self_only' | 'locked';

export const DEFAULT_SITE_CAPTURE_MODE: SiteCaptureMode = 'open';

export type CaptureGuardrailResult =
  | { ok: true; policy: Record<string, unknown>; mode: SiteCaptureMode; narrowed: boolean }
  | { ok: false; error: string; errorCode: 'capture_policy_denies' };

/**
 * Apply the site's guardrail to an ALREADY-VALIDATED bridge policy. Pure: no store, no clock, no
 * network — the mode and the own origin are resolved by the caller and handed in, so the whole
 * narrowing table is unit-testable without a governance blob.
 *
 * `ownOrigin` is this site's canonical origin (site.urls.canonicalHost). It is only consulted for
 * `self_only`; a site that cannot report one is refused in that mode rather than silently widened,
 * because the alternative — falling back to `open` when we cannot tell what "self" means — is the
 * one failure mode a narrowing guardrail must not have.
 */
export const applyCaptureGuardrail = (
  policy: Record<string, unknown>,
  mode: SiteCaptureMode,
  ownOrigin: string | undefined
): CaptureGuardrailResult => {
  if (mode === 'locked') {
    return {
      ok: false,
      error:
        'Site capture is turned off by this site\'s guardrail (Admin → Guardrails → Site capture = Off). The project registry still authorizes it; this site does not.',
      errorCode: 'capture_policy_denies',
    };
  }

  if (mode === 'self_only') {
    if (!ownOrigin) {
      return {
        ok: false,
        error:
          'Site capture is limited to this site\'s own pages by its guardrail, but this site reports no canonical origin (site.urls.canonicalHost), so "own" cannot be resolved. Set the canonical host, or change the guardrail.',
        errorCode: 'capture_policy_denies',
      };
    }
    const origins = (policy.allowedCrawlOrigins as string[]).filter((origin) => origin === ownOrigin);
    if (origins.length === 0) {
      return {
        ok: false,
        error: `Site capture is limited to this site's own pages (${ownOrigin}) by its guardrail, and the project registry's capturePolicy does not authorize that origin. Add it on the project record, or change the guardrail.`,
        errorCode: 'capture_policy_denies',
      };
    }
    return {
      ok: true,
      policy: { ...policy, allowedCrawlOrigins: origins },
      mode,
      narrowed: origins.length < (policy.allowedCrawlOrigins as string[]).length,
    };
  }

  return { ok: true, policy, mode, narrowed: false };
};

/** Read the site's mode off the governance doc. Unset, missing or corrupt → the default (`open`),
 *  matching getBrandImageryOverridePolicy's fail-open posture: an unreadable guardrail must not
 *  become an outage on a plane that never had one. */
export const resolveSiteCaptureMode = (doc: { siteCapture?: string } | null | undefined): SiteCaptureMode => {
  const mode = doc?.siteCapture;
  return mode === 'locked' || mode === 'self_only' || mode === 'open' ? mode : DEFAULT_SITE_CAPTURE_MODE;
};
