/**
 * The per-tenant route facts that live in CODE, exposed to core through the
 * same provider seam every other per-site policy uses (W0 T0.3,
 * KNOWN_ISSUES #40).
 *
 * WHY THIS SEAM EXISTS. `sites/<client>/site.config.ts` carries the
 * infrastructure redirect table — the array that `netlify.toml`'s
 * `[[redirects]]` is drift-guarded against. Those rules OWN reader paths and
 * beat every static file: `/shop` on drlurie is a 301 to
 * `/solutions/shop-preview`, so no page object can ever hold that route.
 * (The `page_shop` EXPORT that used to sit there was never a published object
 * at all — hand-committed pre-object residue, removed in B1; KNOWN_ISSUES #69.
 * The rule stands without it.) The write-time validator could not see any of it,
 * because core must never import a tenant file
 * (`tests/scripts/core-no-site-literals.test.mjs`) and this table is not in
 * the object store.
 *
 * WHY IT FAILS SOFT rather than throwing like `activeCreationPolicy`. Those
 * policies decide whether a write is ALLOWED and an unconfigured provider is a
 * wiring bug that must be loud. This one only widens a uniqueness check: with
 * no provider registered the resolver simply does not know about
 * infrastructure redirects, which is exactly the behaviour that shipped before
 * this module. Throwing here would turn a missing side-effect import in some
 * future entry point into a failed write.
 */
export type RouteOwnershipConfig = {
  /**
   * `from` values of the tenant's infrastructure redirect table, verbatim.
   * A trailing `/*` is a splat and claims the whole family; everything else is
   * an exact path.
   */
  infraRedirectSources: readonly string[];
};

const EMPTY: RouteOwnershipConfig = { infraRedirectSources: [] };

let activeRouteOwnershipProvider: (() => RouteOwnershipConfig) | undefined;

export const setRouteOwnershipProvider = (provider: () => RouteOwnershipConfig): void => {
  activeRouteOwnershipProvider = provider;
};

/** The registered facts, or the empty set — never a throw. See the header. */
export const activeRouteOwnership = (): RouteOwnershipConfig => {
  if (!activeRouteOwnershipProvider) return EMPTY;
  try {
    return activeRouteOwnershipProvider();
  } catch {
    return EMPTY;
  }
};

/** Test seam: drop the registered provider so a test can assert the unconfigured default. */
export const resetRouteOwnershipProviderForTesting = (): void => {
  activeRouteOwnershipProvider = undefined;
};
