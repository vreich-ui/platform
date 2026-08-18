/**
 * Site → core policy bindings for 'site_zilberman'.
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
