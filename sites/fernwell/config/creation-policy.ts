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
  overrides: {
    tracking_config: { agents: ['object-conversion-roundtrip'] },
    // D1: seed-minted singleton — agents edit the declared voice, never mint one.
    editorial_voice: { agents: ['object-conversion-roundtrip'] },
    // Wolf 2026-09-09: editorial_strategy is the voice's twin on this rule too
    // — genesis/human mints the singleton, agents edit it via
    // set_strategy_fields. Same seed identity, same reason.
    editorial_strategy: { agents: ['object-conversion-roundtrip'] },
  },
} satisfies CreationPolicyConfig;
