/**
 * Site → core policy bindings (W11 T11.2).
 *
 * `packages/core` holds the pure policy law (`resolve*Policy`, the active-policy
 * provider seam) and must not import this site's committed config. This module
 * is the site-side wiring that closes that seam: it registers providers that
 * resolve the committed policy configs on first use and cache them —
 * byte-for-byte the same lazy-validate-once behavior the core singletons had
 * before the extraction.
 *
 * W11 T11.10: approval-policy.ts/creation-policy.ts relocated to
 * `sites/drlurie/config/` (this site's own per-site posture files, matching
 * T11.7's `create-site.mjs` scaffold shape for the next client) — values
 * unchanged, only the import path below moved. `media-policy.ts` stays here
 * for now (out of this task's scope).
 *
 * Import this module for its side effect (`import '~/config/policy-bindings'`
 * / the relative equivalent) at any entry point that reaches
 * `activeApprovalPolicy()` / `activeCreationPolicy()` before the first call.
 * Imports are relative (not the `@core` alias) so the module resolves under
 * the Node test runtime as well as under Astro/Vite.
 */
import { approvalPolicyConfig } from './approval-policy.js';
import { creationPolicyConfig } from './creation-policy.js';
import { mediaPolicyConfig } from './media-policy.js';
import { siteIdentityConfig } from './site-identity.js';
import { membershipPolicyConfig } from './membership-policy.js';
import {
  setActiveApprovalPolicyProvider,
  resolveApprovalPolicy,
  type ApprovalPolicy,
} from '../../../packages/core/lib/approval-policy.js';
import {
  setActiveCreationPolicyProvider,
  resolveCreationPolicy,
  type CreationPolicy,
} from '../../../packages/core/lib/creation-policy.js';
import {
  setActiveMediaPolicyProvider,
  resolveMediaPolicy,
  type MediaPolicy,
} from '../../../packages/core/lib/media-policy.js';
import { setSiteIdentityConfigProvider } from '../../../packages/core/lib/site-identity.js';
import { setActiveMembershipPolicyProvider } from '../../../packages/core/lib/membership-policy.js';

let approvalPolicy: ApprovalPolicy | undefined;
setActiveApprovalPolicyProvider((): ApprovalPolicy => (approvalPolicy ??= resolveApprovalPolicy(approvalPolicyConfig)));

let creationPolicy: CreationPolicy | undefined;
setActiveCreationPolicyProvider((): CreationPolicy => (creationPolicy ??= resolveCreationPolicy(creationPolicyConfig)));

let mediaPolicy: MediaPolicy | undefined;
setActiveMediaPolicyProvider((): MediaPolicy => (mediaPolicy ??= resolveMediaPolicy(mediaPolicyConfig)));

// site-identity resolves committed config + process env on each call (env may
// change between calls); the provider just supplies the committed config.
setSiteIdentityConfigProvider((): unknown => siteIdentityConfig);

// W18 T18.7: the committed membership-policy override (runtime store overrides layer on top).
setActiveMembershipPolicyProvider(() => membershipPolicyConfig);
