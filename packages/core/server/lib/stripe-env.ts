/**
 * Stripe mode/key selection (06-shop-module-plan §8.7) — the env carries
 * BOTH key pairs and the server picks by `STRIPE_MODE`:
 *
 *   STRIPE_MODE                'live' | 'test' (default 'test' — a missing
 *                              flag must never charge real cards)
 *   STRIPE_SECRET_KEY          live secret key      (sk_live_…)
 *   STRIPE_WEBHOOK_SECRET      live webhook secret  (whsec_…)
 *   STRIPE_SECRET_KEY_TEST     test secret key      (sk_test_…)
 *   STRIPE_WEBHOOK_SECRET_TEST test webhook secret  (whsec_…)
 *
 * Products mirror the split: live linkage in `commerce.stripe`, test ids in
 * the `commerce.stripe_test` mirror block (dropped after launch). The one
 * `stripeLinkageForMode` helper is the only place that mapping lives.
 *
 * All four key envs are marked in the deploy-safety scanner
 * (netlify/lib/object-validate.ts PROTECTED_ENV_KEYS) — a key pasted into
 * content blocks every deploy (§8.5). Keys never leave env; this module
 * hands out a lazily-constructed client, never raw keys.
 */
import type Stripe from 'stripe';

import type { ProductCommerce, StripeLinkage } from '../../schema/bodies/product-v1.js';

export type StripeMode = 'live' | 'test';

export const stripeMode = (env: NodeJS.ProcessEnv = process.env): StripeMode =>
  (env.STRIPE_MODE ?? '').trim().toLowerCase() === 'live' ? 'live' : 'test';

export const stripeSecretKey = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const value = (stripeMode(env) === 'live' ? env.STRIPE_SECRET_KEY : env.STRIPE_SECRET_KEY_TEST)?.trim();
  return value ? value : undefined;
};

export const stripeWebhookSecret = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const value = (stripeMode(env) === 'live' ? env.STRIPE_WEBHOOK_SECRET : env.STRIPE_WEBHOOK_SECRET_TEST)?.trim();
  return value ? value : undefined;
};

/**
 * T16.5: the single predicate for "is commerce/Stripe configured" — both the
 * real call path (getStripeClient, via stripeSecretKey above) and
 * capability-status.ts's `commerce` family read the same
 * stripeSecretKey/stripeMode logic, so there is exactly one place the
 * mode->env-var mapping lives. Reports only the ONE key the active mode
 * actually needs — the other mode's key is irrelevant to whether commerce
 * works right now.
 */
export const commerceMissingEnvVars = (env: NodeJS.ProcessEnv = process.env): string[] =>
  stripeSecretKey(env) ? [] : [stripeMode(env) === 'live' ? 'STRIPE_SECRET_KEY' : 'STRIPE_SECRET_KEY_TEST'];

export const isCommerceConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  commerceMissingEnvVars(env).length === 0;

/** The product linkage block matching the server's mode (§8.7). */
export const stripeLinkageForMode = (
  commerce: Pick<ProductCommerce, 'stripe' | 'stripe_test'>,
  env: NodeJS.ProcessEnv = process.env
): StripeLinkage | undefined => (stripeMode(env) === 'live' ? commerce.stripe : commerce.stripe_test);

let cachedClient: { key: string; client: Stripe } | undefined;
let injectedClientForTesting: Stripe | undefined;

/**
 * Lazy singleton Stripe client for the active mode; undefined when the mode's
 * key is unconfigured (callers 503 — never a half-configured charge path).
 * The SDK import is dynamic so cold paths (every non-commerce function) never
 * pay for it.
 */
export const getStripeClient = async (env: NodeJS.ProcessEnv = process.env): Promise<Stripe | undefined> => {
  if (injectedClientForTesting) return injectedClientForTesting;
  const key = stripeSecretKey(env);
  if (!key) return undefined;
  if (cachedClient?.key === key) return cachedClient.client;
  const { default: StripeCtor } = await import('stripe');
  const client = new StripeCtor(key);
  cachedClient = { key, client };
  return client;
};

/**
 * Test seams: inject a fake client (network calls are unmockable otherwise)
 * / drop the cached one. Mirrors setNetlifyBlobsModuleForTesting.
 */
export const setStripeClientForTesting = (client?: unknown): void => {
  injectedClientForTesting = client as Stripe | undefined;
};
export const resetStripeClientForTesting = (): void => {
  cachedClient = undefined;
  injectedClientForTesting = undefined;
};
