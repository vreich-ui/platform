/**
 * Site → core policy bindings for 'site_genesis_lab_2'.
 *
 * `packages/core` holds the policy LAW and the provider seams; this module is
 * the site-side wiring that closes them. Import it for its side effect at any
 * entry point that reaches `activeApprovalPolicy()` / `activeCreationPolicy()`
 * / `activeMediaPolicy()` / `getSiteIdentity()` before the first call — every
 * Netlify function shim, and every client `<script>` that touches the auth
 * client (W14 T14.0; tests/scripts/client-scripts-site-bindings enforces that
 * half).
 *
 * Imports are RELATIVE, not the `@core` alias, so the module resolves under
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
import { siteConfig } from '../site.config.js';
import { setRouteOwnershipProvider } from '../../../packages/core/lib/route-ownership.js';

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

// W0 T0.3 (KNOWN_ISSUES #40): the infrastructure redirect table is CODE — the
// array `netlify.toml` is drift-guarded against — so the write-time route
// resolver can only see it through a provider. Sources only: the resolver asks
// "who owns this path", never "where does it go".
setRouteOwnershipProvider(() => ({ infraRedirectSources: siteConfig.redirects.map((redirect) => redirect.from) }));
