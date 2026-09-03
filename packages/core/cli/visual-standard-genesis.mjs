/**
 * P6 — shared genesis/backfill logic for the house `visual_standard`
 * (`vis_<client>`, BRIEF.md §3.1/§R1-R2) every site is born with.
 *
 * `visual_standard` (the object TYPE) and `site_apply_brand_imagery` (the
 * verb) are being built CONCURRENTLY in another worktree (tasks P1/P3) — see
 * BRIEF.md's dependency note. This module never imports either: the house
 * standard's BODY is assembled here as a plain object literal (matching the
 * frozen §3.1 shape by hand, not by importing a schema module that does not
 * exist yet in THIS worktree), and every reference to the new object type or
 * the new verb elsewhere in this codebase is a plain STRING (an MCP tool
 * name, an `object_type` value) — never an import — so this module, and
 * everything that calls it, already compiles today and needs no changes once
 * P1/P3 land; only the live registry/verb behind those strings does.
 *
 * `deriveBrandImageryFromTokens` (packages/core/server/lib/
 * brand-imagery-derive-core.mjs) is the one existing, already-shipped piece
 * this module leans on — never reimplemented, per the P6 task brief. It is
 * plain JavaScript precisely so a `.mjs` like this one can import it under
 * bare `node` (`node packages/core/cli/create-site.mjs`,
 * `node scripts/backfill-visual-standard.mjs`) on every Node this repo
 * supports, with no build step and no loader; the typed parse half and the
 * TypeScript type exports live beside it in brand-imagery-derive.ts, which
 * re-exports the derivation for its TypeScript callers.
 */
import { deriveBrandImageryFromTokens } from '../server/lib/brand-imagery-derive-core.mjs';

/** Re-exported so a caller can derive a record itself if it ever needs to. */
export { deriveBrandImageryFromTokens };

/** `vis_<client>` — BRIEF.md R2: the house standard is a singleton per site, id-shaped like `voice_<client>`. */
export const visualStandardIdFor = (clientId) => `vis_${clientId}`;

const capLength = (value, max) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);

// A brand-new site (create-site.mjs) and a pre-existing tenant with no
// declared niche (scripts/backfill-visual-standard.mjs) both fall back to
// this: a SMALL, deliberately generic, SUBJECT-ONLY set — no medium/style
// words (R4: "nobody writes style words into prompt"; the style half lives
// entirely in `brandImagery`, derived separately).
export const GENERIC_SAMPLE_SUBJECTS = [
  'a person reading at a small table',
  'an open notebook beside a warm drink',
  'a pair of hands writing notes',
  'a small potted plant on a sunlit windowsill',
];

/**
 * Subject-only example prompts for the mood board's `sampleSubjects`
 * (visual_standard.v1, 1..6 entries). Neither `create-site.mjs` nor an
 * existing tenant's site body carries a "niche" field today — `niche` is
 * accepted here purely so a future caller that DOES have one gets subjects
 * shaped around it, without this module changing; today every caller passes
 * `undefined` and gets the generic set.
 */
export const sampleSubjectsForNiche = (niche) => {
  const trimmed = typeof niche === 'string' ? niche.trim() : '';
  if (!trimmed) return [...GENERIC_SAMPLE_SUBJECTS];
  return [
    `a person in a ${trimmed} setting, an everyday moment`,
    `a close-up of hands at work in ${trimmed}`,
    `a quiet still-life of objects related to ${trimmed}`,
  ];
};

/**
 * Assembles the house `visual_standard.v1` body (BRIEF §3.1) for one site,
 * from a `brandImagery` record already derived by
 * `deriveBrandImageryFromTokens`. Pure — no I/O, no ids minted, nothing
 * written; callers (`create-site.mjs`'s scaffold, the backfill script) decide
 * separately whether/how to persist it.
 *
 * `brandName` is a live field (a real client's display name), not a
 * generated id — capped defensively to the §3.1 `label`/`description`
 * bounds (80 / 400 chars) since nothing upstream of this module enforces
 * that length today.
 */
export const buildHouseVisualStandardBody = ({ brandName, brandImagery, niche, references = [] }) => ({
  version: 1,
  kind: 'house',
  label: capLength(`${brandName} — house visual standard`, 80),
  description: capLength(
    `The default image style for ${brandName}, derived automatically from its brand palette (brandTokens) rather than hand-authored. Replace with a client-specific mood board and writer proposal once real brand direction exists.`,
    400
  ),
  brandImagery,
  references,
  sampleSubjects: sampleSubjectsForNiche(niche),
  derivedFrom: { method: 'tokens' },
  status: 'active',
});
