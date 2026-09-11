/**
 * REGION REGISTRY — where things are allowed to live on the reader side.
 *
 * WHAT CHANGED AND WHY (W1 T1.1). This file is the former
 * `structural-capacity.ts`, widened. That file held exactly one row (the
 * header's ≤3 actions) and described itself as "the declarative hard-rules
 * layer", but it could only talk about one slot, so every OTHER structural
 * fact about a page lived in prose or in the validator's control flow.
 *
 * The page a reader sees is not one list of sections. It is a header, an
 * optional announcement strip, the ordered FLOW of sections, and — reserved
 * for later waves — a sticky bottom bar, floating actions, and the code-owned
 * overlay layer (the mobile menu). Naming those regions now, while the honest
 * answer for all 25 placeable kinds is "flow", is what makes the first sticky
 * kind an entry in a table rather than a new concept invented under deadline.
 *
 * DERIVED, NOT HAND-AUTHORED. `flow`'s allow-list is computed from the kinds
 * whose `footprint.region` is `flow` (`components/definitions.ts`), the same
 * way `object-contract.ts` derives everything it publishes. A new kind cannot
 * be added to the flow region by editing this file — it is added by declaring
 * its footprint, which the type system already requires.
 *
 * TWO DIFFERENT QUESTIONS, kept apart on purpose:
 *   - `footprint.region` answers "where may an instance of this KIND be
 *     placed", and today every bound kind answers `flow`.
 *   - a region's `allowed` answers "what may this REGION hold", which for
 *     `header` / `footer` is a navigation object and for `announcement` is a
 *     shared `section` object referenced by `site.chrome.announcement`. A
 *     `cta_banner` is flow-placeable AND referenceable by the announcement
 *     region; those are not in conflict.
 *
 * `level` chooses severity, consumed by the validation pipeline
 * (`server/lib/object-validate.ts`):
 *   - 'warning' advises and NEVER blocks a publish (the slot degrades
 *     gracefully — e.g. a flex-wrapping container just wraps).
 *   - 'missing' hard-blocks at publish time (reserve for a bound whose
 *     violation genuinely breaks rendering or layout).
 *
 * Content REMOVAL stays legal everywhere: no `min` is set on any row, so an
 * agent may empty a slot — that is a content decision, not a structural break.
 */
import { REGION_IDS, type RegionId } from './region-ids.js';
import { SECTION_DEFINITIONS, sectionFootprint } from './components/definitions.js';
import { REGISTERED_SECTION_TYPES, type RegisteredSectionType } from './components/registered-types.js';
import type { SectionType } from '../../schema/bodies/section-v1.js';
import type { NavigationBody } from '../../schema/bodies/navigation-v1.js';

export { REGION_IDS, type RegionId };

export type CapacityRule = {
  /** Flag when the slot holds MORE than this many entries. */
  max?: number;
  /** Flag when the slot holds FEWER than this many entries. */
  min?: number;
  /** 'warning' advises; 'missing' hard-blocks at publish. */
  level: 'warning' | 'missing';
};

export type RegionOccupancy = {
  /** Maximum instances the region holds. Absent = unbounded. */
  max?: number;
  /** True when position within the region is meaningful. */
  ordered?: boolean;
  /** `floating` only: the cap is per screen corner, not per page. */
  perCorner?: boolean;
};

export type RegionAllowance =
  /** One navigation object (header / footer). */
  | { kind: 'navigation' }
  /** Named section kinds, referenced rather than placed inline. */
  | { kind: 'section_types'; types: readonly SectionType[] }
  /** Every standalone-placeable kind — derived from the footprints. */
  | { kind: 'all_placeable'; types: readonly SectionType[] }
  /** The renderer owns this region entirely; no object may target it. */
  | { kind: 'code_owned' }
  /** Declared so the ordering exists, with nothing admitted yet. */
  | { kind: 'reserved' };

export type RegionRow = {
  id: RegionId;
  occupancy: RegionOccupancy;
  allowed: RegionAllowance;
  /** Severity for a capacity breach in this region. 'none' = nothing to enforce yet. */
  level: 'warning' | 'missing' | 'none';
  /**
   * FALSE when the region is declared here but nothing renders it. Today only
   * `announcement` (KNOWN_ISSUES #68): `site.chrome.announcement.sectionRef`
   * parses, validates its reference, publishes — and no component reads it.
   * Stating it here is the difference between a documented gap and a silent
   * one.
   */
  rendered: boolean;
  description: string;
};

/** Kinds whose declared footprint puts them in this region. */
export const sectionTypesInRegion = (region: RegionId): RegisteredSectionType[] =>
  REGISTERED_SECTION_TYPES.filter((type) => SECTION_DEFINITIONS[type].footprint.region === region);

export const REGION_REGISTRY: Record<RegionId, RegionRow> = {
  header: {
    id: 'header',
    occupancy: { max: 1 },
    allowed: { kind: 'navigation' },
    level: 'warning',
    rendered: true,
    /**
     * Header-actions cap rationale (the owner's "adding a button conflicts
     * with the menu" case): Header.astro lays the center menu and the
     * right-side action cluster into a shared, finite horizontal budget (the
     * position:'center' three-column grid). Extra header CTAs crowd that
     * budget against the menu. It wraps, it does not crash — so this is a
     * warning, tuned to one slot of headroom over the seeded two-action
     * header.
     */
    description: 'One navigation object, with at most 3 top-level actions; extra actions wrap and crowd the menu.',
  },
  announcement: {
    id: 'announcement',
    occupancy: { max: 1 },
    allowed: { kind: 'section_types', types: ['cta_banner'] },
    level: 'warning',
    rendered: false,
    description:
      'At most one compact cta_banner, referenced by site.chrome.announcement.sectionRef. DECLARED BUT NOT RENDERED — see KNOWN_ISSUES #68.',
  },
  flow: {
    id: 'flow',
    occupancy: { ordered: true },
    allowed: { kind: 'all_placeable', types: sectionTypesInRegion('flow') },
    level: 'none',
    rendered: true,
    description: 'The ordered body of the page: unbounded, every standalone-placeable kind, order is meaning.',
  },
  sticky_bottom: {
    id: 'sticky_bottom',
    occupancy: { max: 1 },
    /**
     * CODE-OWNED AND ALREADY OCCUPIED — found by the W1 T1.2 z-index lint, not
     * assumed. `lib/tracking/consent/banner-html.ts` renders a `fixed
     * inset-x-0 bottom-0` consent banner on every tenant, which IS this
     * region's one occupant. The brief expected an empty reserved row; the
     * code says otherwise, and the row says what the code does.
     *
     * The consequence is a real design input for the sticky_cta wave rather
     * than a documentation detail: the bottom edge is not free. A future
     * agent-placeable kind here has to coexist with the consent banner, and
     * `occupancy.max: 1` is why it cannot simply be added.
     */
    allowed: { kind: 'code_owned' },
    level: 'missing',
    rendered: true,
    description:
      'Code-owned and occupied: the tracking consent banner. No object may target it, and there is no room for a second occupant — a future sticky_cta must coexist with the banner, not sit where it sits.',
  },
  floating: {
    id: 'floating',
    occupancy: { max: 1, perCorner: true },
    allowed: { kind: 'reserved' },
    level: 'missing',
    rendered: false,
    description:
      'Reserved for a future floating_action kind, at most one per corner. Empty allow-list today.',
  },
  overlay: {
    id: 'overlay',
    occupancy: {},
    allowed: { kind: 'code_owned' },
    level: 'none',
    rendered: true,
    description: 'Code-owned (the mobile menu). No object may target it; nothing here is agent-editable.',
  },
  footer: {
    id: 'footer',
    occupancy: { max: 1 },
    allowed: { kind: 'navigation' },
    level: 'missing',
    rendered: true,
    description:
      'One navigation object. A page whose pageType is "home" must set navigationOverrides.footer — the renderer throws without it and the ENTIRE site build dies.',
  },
};

export const REGION_ROWS: RegionRow[] = REGION_IDS.map((id) => REGION_REGISTRY[id]);

/**
 * navigation.role → capacity rule for that role's top-level `actions[]` slot.
 *
 * Kept as its own export because the validator reads it by role, not by
 * region; the number and the severity now come from the header row so the
 * table and the enforcement cannot disagree.
 */
export const navActionCapacity: Partial<Record<NavigationBody['role'], CapacityRule>> = {
  header: { max: 3, level: 'warning' },
};

/** Where a kind may be placed, or `undefined` for a leaf/pointer type (card, shared_ref). */
export const regionForSectionType = (type: string): RegionId | undefined => sectionFootprint(type)?.region;
