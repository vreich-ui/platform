/**
 * variant-serve (site_zilberman) — the T21.5 edge function: concurrent A/B arms
 * served under ONE url. Runs on Netlify's Deno runtime for EVERY request on every tenant
 * (`path = "/*"`), so its first job is to do nothing at all.
 *
 * Two files, one purpose:
 *   - `_experiments.generated.json` (next to this file) is written by
 *     `scripts/tracking-experiments-build.mjs` during the build, from the
 *     site's published `tracking.json` plus the sink's weight table. Edge
 *     bundles cannot import from `public/`, which is why the map is emitted
 *     HERE as well; the `public/_trk/experiments.json` copy exists for the
 *     loader and the tests.
 *   - every decision this file makes lives in
 *     `./edge-core.ts` — a build-vendored copy of
 *     `packages/core/lib/tracking/experiments/edge-core.ts`, type-checked there
 *     and exercised by `tests/netlify/tracking-experiments-edge.test.ts`. This
 *     file is only the Deno wiring, and is intentionally too thin to hide a
 *     bug in.
 *
 * The zero-experiment guarantee: with `experiments: []` the generated map is
 * `{}`, `HAS_EXPERIMENTS` is false at module scope, and every request returns
 * `context.next()` before a cookie, a geo lookup, or an RNG call happens.
 *
 * This file is EXCLUDED from `tsconfig.json` / `tsconfig.test.json` because
 * Deno resolves the `.ts` specifier below and tsc will not (TS5097). That
 * exclusion is exactly why nothing decidable may move into it.
 */
import generated from './_experiments.generated.json' with { type: 'json' };
import {
  buildControlRouteIndex,
  decide,
  VARIANT_HEADER,
  type EdgeConsent,
  type ExperimentMapLike,
} from './_shared/edge-core.ts';

type Generated = { experiments: ExperimentMapLike; consent: EdgeConsent };

const DATA = generated as unknown as Generated;
const MAP: ExperimentMapLike = DATA.experiments ?? {};
const CONSENT: EdgeConsent = DATA.consent ?? { restricted_regions: [], honor_gpc: true };
const CONTROL_ROUTES = buildControlRouteIndex(MAP);
const HAS_EXPERIMENTS = Object.keys(CONTROL_ROUTES).length > 0;

type EdgeContext = {
  next: () => Promise<Response>;
  rewrite: (url: string | URL) => Promise<Response>;
  geo?: { country?: { code?: string | null } | null } | null;
  cookies?: unknown;
};

export default async (request: Request, context: EdgeContext): Promise<Response | undefined> => {
  // Step 1 — the no-op. Cheapest possible exit for the whole fleet.
  if (!HAS_EXPERIMENTS) return context.next();

  const url = new URL(request.url);
  const decision = decide({
    map: MAP,
    controlRouteIndex: CONTROL_ROUTES,
    consent: CONSENT,
    request: {
      path: url.pathname,
      cookieHeader: request.headers.get('cookie'),
      secGpc: request.headers.get('sec-gpc'),
      country: context.geo?.country?.code ?? null,
    },
    roll: Math.random(),
  });

  if (decision.kind === 'next') return context.next();

  // Control and variant both REWRITE: the visitor's URL never changes, so a
  // shared link, a canonical, and an analytics `url.path` all keep naming the
  // control route whichever arm rendered.
  const target = new URL(url.toString());
  target.pathname = decision.route;
  const response = await context.rewrite(target);
  const headers = new Headers(response.headers);
  headers.set(VARIANT_HEADER, decision.variant_id);
  // Arms differ per visitor under the same URL — say so, or a shared cache
  // would pin one arm for everyone behind it.
  headers.append('Vary', 'Cookie');
  if (decision.kind === 'serve' && decision.setCookie) headers.append('Set-Cookie', decision.setCookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

export const config = { path: '/*' };
