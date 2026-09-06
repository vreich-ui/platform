/**
 * The variant-serving DECISION (T21.5) — every branch the edge function takes,
 * as pure functions over plain values.
 *
 * Why the logic lives here and not in the edge file: `netlify/edge-functions/`
 * runs on DENO and is excluded from `tsconfig`/`astro check` (Deno-style `.ts`
 * import specifiers), so a bug in an `if` written there would be invisible to
 * `npm run check` and `npm test`. This module has NO imports of any kind, is
 * type-checked by the repo, and is what the tests exercise; the edge file is a
 * ~30-line wrapper that maps `Decision` onto `context.next()`/`rewrite()`.
 *
 * THE ORDER IS THE FEATURE — it is asserted by name in the test suite:
 *
 *   1. Empty map            → next()   (the zero-experiment no-op)
 *   2. Path is not a served CONTROL route → next()
 *      Nothing below this line runs for the other ~100% of requests: no
 *      cookie parse, no geo read, no RNG. A variant's OWN route is also not a
 *      control route, so a direct hit on it passes through untouched.
 *   3. Consent gate → CONTROL (never a rewrite, never a cookie write):
 *        a. `Sec-GPC: 1` (when honor_gpc), OR
 *        b. geo country ∈ restricted_regions without a `_dlconsent` cookie
 *           carrying `analytics:true`.
 *      Unknown/absent country is NOT treated as restricted here — see
 *      `isRestrictedRegion`'s note.
 *   4. Sticky `_dlab` cookie naming a still-served arm → that arm, no re-set.
 *   5. Otherwise: weighted pick over the arms, and SET the cookie.
 *
 * The URL never changes in any branch: step 5 and step 4 produce a REWRITE,
 * which Netlify serves under the requested (control) URL.
 */

export type ServedArmLike = { variant_id: string; route: string; weight: number };
export type ExperimentMapLike = Record<string, { route: string; arms: ServedArmLike[] }>;

export type EdgeConsent = {
  /** ISO-3166 alpha-2 codes that require analytics consent before a split. */
  restricted_regions: readonly string[];
  honor_gpc: boolean;
};

export type EdgeRequestFacts = {
  /** `URL.pathname` of the incoming request. */
  path: string;
  /** Raw `Cookie:` header value, or null. */
  cookieHeader: string | null;
  /** Raw `Sec-GPC:` header value, or null. */
  secGpc: string | null;
  /** `context.geo.country.code` — null when the edge could not resolve one. */
  country: string | null;
};

export type Decision =
  /** Hand the request straight to the origin. Nothing was read or written. */
  | { kind: 'next'; reason: 'no-experiments' | 'not-a-control-route' }
  /** Serve the control arm. Never sets a cookie (a held visitor stays held). */
  | { kind: 'control'; experiment_id: string; variant_id: string; route: string; reason: 'gpc' | 'restricted-region' }
  /** Rewrite to an arm. `setCookie` is present only on a fresh assignment. */
  | {
      kind: 'serve';
      experiment_id: string;
      variant_id: string;
      route: string;
      reason: 'sticky-cookie' | 'weighted-pick';
      setCookie?: string;
    };

export const ASSIGNMENT_COOKIE = '_dlab';
export const CONSENT_COOKIE = '_dlconsent';
/** The served arm, echoed on every response the function touches. */
export const VARIANT_HEADER = 'x-trk-variant';
export const ASSIGNMENT_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

// ── cookie plumbing (no dependencies; the edge has no cookie library) ────────

/** Parse a `Cookie:` header into a flat record. Last value for a name wins. */
export const parseCookieHeader = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
};

/**
 * Read the `_dlab` assignment map — `{object_id: variant_id}`, JSON, URI
 * encoded. Any parse failure is a MISS, never an error: a corrupt cookie
 * re-randomizes rather than 500s.
 */
export const readAssignments = (cookies: Record<string, string>): Record<string, string> => {
  const raw = cookies[ASSIGNMENT_COOKIE];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
};

/** Serialize the assignment map back into a Set-Cookie value. */
export const serializeAssignments = (assignments: Record<string, string>): string =>
  `${ASSIGNMENT_COOKIE}=${encodeURIComponent(JSON.stringify(assignments))}; Max-Age=${ASSIGNMENT_COOKIE_MAX_AGE}; SameSite=Lax; Secure; Path=/`;

/**
 * Whether the visitor has granted ANALYTICS consent, as visible AT THE EDGE.
 *
 * KNOWN GAP, deliberate and fail-safe: the consent runtime
 * (lib/tracking/consent/runtime.ts) persists `_dlconsent` in **localStorage**,
 * which no edge function can read. This reads a `_dlconsent` COOKIE of the
 * same shape, per the T21.5 spec. Until something mirrors the choice into a
 * cookie, a restricted-region visitor therefore always reads as
 * "no analytics consent" and is served the CONTROL — the conservative
 * direction, and identical to what the pre-experiment site served.
 */
export const hasAnalyticsConsent = (cookies: Record<string, string>): boolean => {
  const raw = cookies[CONSENT_COOKIE];
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    return !!parsed && typeof parsed === 'object' && (parsed as { analytics?: unknown }).analytics === true;
  } catch {
    return false;
  }
};

/** `Sec-GPC: 1` — the only value the spec defines as "do not sell/share". */
export const isGpcSignalled = (secGpc: string | null): boolean => secGpc?.trim() === '1';

/**
 * Restricted only on a CONFIRMED match. The consent runtime's "unknown region
 * = restricted" rule governs whether an advertising SCRIPT may execute; this
 * gate governs which ARTICLE a reader sees, which is not a tracking decision
 * at all — an unresolvable country must not silently pin the whole edge to the
 * control (that would make the experiment's split depend on Netlify's geo
 * coverage). Restricted-region readers are held to the control regardless.
 */
export const isRestrictedRegion = (country: string | null, regions: readonly string[]): boolean =>
  country !== null && regions.includes(country.toUpperCase());

/**
 * Weighted pick over the arms. `roll` is a number in [0,1) — the caller owns
 * randomness so the distribution is testable with a seeded source. Weights are
 * integer shares (see `equalWeights`); a zero total degrades to the first arm.
 */
export const pickArm = (arms: readonly ServedArmLike[], roll: number): ServedArmLike | null => {
  if (arms.length === 0) return null;
  const total = arms.reduce((sum, arm) => sum + Math.max(0, arm.weight), 0);
  if (total <= 0) return arms[0]!;
  const bounded = roll < 0 ? 0 : roll >= 1 ? 0.999999999 : roll;
  let cursor = bounded * total;
  for (const arm of arms) {
    cursor -= Math.max(0, arm.weight);
    if (cursor < 0) return arm;
  }
  return arms[arms.length - 1]!;
};

/** Normalize a pathname for control-route lookup (trailing slash tolerated). */
export const normalizePath = (path: string): string => {
  const withoutQuery = path.split('?')[0]!.split('#')[0]!;
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) return withoutQuery.replace(/\/+$/, '');
  return withoutQuery || '/';
};

/** Control route → experiment id. Built once per isolate, not per request. */
export const buildControlRouteIndex = (map: ExperimentMapLike): Record<string, string> => {
  const index: Record<string, string> = {};
  for (const [experimentId, entry] of Object.entries(map)) index[normalizePath(entry.route)] = experimentId;
  return index;
};

export type DecideInput = {
  map: ExperimentMapLike;
  controlRouteIndex: Record<string, string>;
  consent: EdgeConsent;
  request: EdgeRequestFacts;
  /** [0,1) — injected so the distribution is deterministic under test. */
  roll: number;
};

/** THE decision. See the ordered list at the top of this file. */
export const decide = ({ map, controlRouteIndex, consent, request, roll }: DecideInput): Decision => {
  // 1. Zero-experiment: the whole feature is inert. (The edge wrapper also
  //    short-circuits on a module-level constant, so this is the second guard,
  //    not the only one.)
  if (Object.keys(controlRouteIndex).length === 0) return { kind: 'next', reason: 'no-experiments' };

  // 2. Control-route gate, BEFORE any cookie/geo/RNG work.
  const experimentId = controlRouteIndex[normalizePath(request.path)];
  if (experimentId === undefined) return { kind: 'next', reason: 'not-a-control-route' };
  const entry = map[experimentId];
  if (!entry) return { kind: 'next', reason: 'not-a-control-route' };

  // 3. Consent gate → control, no cookie written.
  const cookies = parseCookieHeader(request.cookieHeader);
  if (consent.honor_gpc && isGpcSignalled(request.secGpc)) {
    return {
      kind: 'control',
      experiment_id: experimentId,
      variant_id: experimentId,
      route: entry.route,
      reason: 'gpc',
    };
  }
  if (isRestrictedRegion(request.country, consent.restricted_regions) && !hasAnalyticsConsent(cookies)) {
    return {
      kind: 'control',
      experiment_id: experimentId,
      variant_id: experimentId,
      route: entry.route,
      reason: 'restricted-region',
    };
  }

  // 4. Sticky assignment, only while that arm is still served.
  const assignments = readAssignments(cookies);
  const assigned = assignments[experimentId];
  const stickyArm = assigned ? entry.arms.find((arm) => arm.variant_id === assigned) : undefined;
  if (stickyArm) {
    return {
      kind: 'serve',
      experiment_id: experimentId,
      variant_id: stickyArm.variant_id,
      route: stickyArm.route,
      reason: 'sticky-cookie',
    };
  }

  // 5. Fresh weighted assignment + cookie.
  const picked = pickArm(entry.arms, roll);
  if (!picked) return { kind: 'next', reason: 'not-a-control-route' };
  return {
    kind: 'serve',
    experiment_id: experimentId,
    variant_id: picked.variant_id,
    route: picked.route,
    reason: 'weighted-pick',
    setCookie: serializeAssignments({ ...assignments, [experimentId]: picked.variant_id }),
  };
};
