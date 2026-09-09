/**
 * The COMMITTED creation-policy config (W8.3b) — who may CREATE objects of
 * each type. Wolf's one-file lever, the approval-policy twin: edit this file
 * to restrict a type, no code changes.
 *
 *   master: 'open'                    → any principal creates any type;
 *   master: { agents: ['name', …] }   → only listed agents (humans always may);
 *   overrides.<type>                  → per-type rule beating the master,
 *                                       e.g. template: { agents: ['site-builder'] }.
 *
 * Dev-stage default: fully open — the seam exists (enforced in the create/
 * instantiate verbs, surfaced in every object_contract), the restrictions
 * arrive when Wolf writes them. ⚠️ agent names are SELF-DECLARED unless a
 * per-agent credential (W11 T11.10, `packages/core/server/lib/agent-keys.ts`)
 * verified this call — treat an unverified name as coordination, not
 * security (full caveat in packages/core/lib/creation-policy.ts).
 *
 * W11 T11.10: relocated from `src/config/creation-policy.ts` — this IS
 * Dr-Lurie's per-site posture file now (values unchanged, verbatim); a
 * freshly-scaffolded client (T11.7's create-site.mjs) gets its own copy at
 * this same `sites/<client>/config/` path from day one.
 */
import type { CreationPolicyConfig } from '../../../packages/core/lib/creation-policy.js';

export const creationPolicyConfig = {
  master: 'open',
  // W13 (12-plan §3 governance, OQ-W13-2 ruling 2026-07-19): tracking_config
  // is human/seed-minted ONLY — agents edit the singleton, they never mint
  // one. Publish ships AUTONOMOUS (no approval-policy override; the master
  // covers it); the posture gains an owner UI toggle in T13.12.
  // T13.10: 'object-conversion-roundtrip' IS the sanctioned seed identity —
  // the ruling's "seeds mint" needs a name, and the conversion-factory
  // driver is the seed machinery (self-declared until verified — T11.10 —
  // proves it). Casual agents remain excluded.
  overrides: {
    tracking_config: { agents: ['object-conversion-roundtrip'] },
    // D1 (2026-07-28): editorial_voice follows the same rule — seed/human-minted
    // singleton, agents edit it via set_voice_fields.
    editorial_voice: { agents: ['object-conversion-roundtrip'] },
    // Wolf 2026-09-09: editorial_strategy is the voice's twin on this rule too
    // — genesis/human mints the singleton, agents edit it via
    // set_strategy_fields. Same seed identity, same reason.
    editorial_strategy: { agents: ['object-conversion-roundtrip'] },
  },
} satisfies CreationPolicyConfig;
