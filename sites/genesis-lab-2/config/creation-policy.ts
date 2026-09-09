/**
 * Who may MINT objects of each type on this site. `master: 'open'` lets any
 * authenticated agent create; an override names the only agents allowed.
 *
 * `tracking_config` is seed-minted only — agents edit the singleton, they
 * never create one.
 */
import type { CreationPolicyConfig } from '../../../packages/core/lib/creation-policy.js';

export const creationPolicyConfig = {
  master: 'open',
  overrides: { tracking_config: { agents: ['object-conversion-roundtrip'] } },
} satisfies CreationPolicyConfig;
