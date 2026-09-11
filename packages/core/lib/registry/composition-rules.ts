/**
 * COMPOSITION RULES — the page-shape law, as data (W1 T1.3).
 *
 * The PageType rules already answer "may this KIND appear on this page".
 * Nothing answered "does this ARRANGEMENT of kinds make a page a reader can
 * use": two heroes, a second newsletter form, four CTA banners in a row, the
 * same anchor twice. Those are the failures an agent composes by accident,
 * because each individual section is valid.
 *
 * DATA, NOT CONTROL FLOW. Every rule below is an id, a severity and the
 * parameters it needs. `object-validate.ts` evaluates them and
 * `object-contract.ts` publishes them, both reading THIS file — so the rule an
 * agent is told about and the rule that refuses its write are the same row.
 *
 * ENUM-ONLY, DELIBERATELY. No prose, no "prefer a lede here" guidance: that is
 * the composition playbook, and it is W2. A rule in this file either fires or
 * does not.
 *
 * The singleton list and the viewport budget are DERIVED from the component
 * footprints (`components/definitions.ts`), not typed here a second time: a
 * kind is a singleton because its own registry module says so.
 */
import { SECTION_DEFINITIONS } from './components/definitions.js';
import { REGISTERED_SECTION_TYPES } from './components/registered-types.js';
import type { SectionType } from '../../schema/bodies/section-v1.js';

export type CompositionSeverity = 'blocks_write' | 'blocks_publish' | 'warns';

export type CompositionRule = {
  id: string;
  label: string;
  severity: CompositionSeverity;
  /** False would mean "declared but not evaluated". Every rule here is live. */
  enforced_live: boolean;
  description: string;
};

/** Page-opening kinds: campaign-weight openers that only make sense first. */
export const OPENER_TYPES: readonly SectionType[] = ['hero', 'lede'];

/**
 * Kinds that may legally repeat back-to-back. `prose` and `media` are the two
 * that compose a long-form page BY repeating — alternating text and images is
 * the shape, not a mistake.
 */
export const ADJACENCY_EXEMPT_TYPES: readonly SectionType[] = ['prose', 'media'];

/** Asking kinds, and how many a single page may carry before it reads as a pitch. */
export const CTA_DENSITY_TYPES: readonly SectionType[] = ['cta_banner', 'pricing_table', 'product_preview'];
export const CTA_DENSITY_MAX = 3;

/**
 * At most one per page — derived from `footprint.singleton`. Two newsletter
 * forms, two contact forms or two search boxes on one page are an authoring
 * accident every time: the reader cannot tell which one is the real one, and
 * duplicate form ids break the second one's submission.
 */
export const SINGLETON_SECTION_TYPES: readonly SectionType[] = REGISTERED_SECTION_TYPES.filter(
  (type) => SECTION_DEFINITIONS[type].footprint.singleton === true
);

/**
 * Share of a small (`sm`) viewport each height band occupies, and the total an
 * edge-pinned page may spend. NO-OP TODAY: no kind declares an `edge`, so the
 * sum is always 0. It exists now so the first sticky kind lands against a
 * budget that already has a number and a test, rather than inventing one.
 */
export const VIEWPORT_BUDGET = {
  percentByHeightClass: { xs: 8, s: 12, m: 20 } as const,
  maxPercentOfSmallViewport: 25,
};

export const COMPOSITION_RULES: readonly CompositionRule[] = [
  {
    id: 'structure_region_capacity',
    label: 'Region capacity',
    severity: 'blocks_publish',
    enforced_live: true,
    description:
      'Each region holds at most what region-registry.ts says it holds (flow is unbounded and ordered). A kind whose footprint names a reserved region cannot be placed at all.',
  },
  {
    id: 'structure_opener',
    label: 'Opener position',
    severity: 'warns',
    enforced_live: true,
    description: 'hero and lede belong at position 0 only.',
  },
  {
    id: 'structure_singletons',
    label: 'Singleton sections',
    /**
     * WARNS, not blocks — corrected against the committed data (W1 T1.3).
     * `page_object_showcase` carries two newsletter forms on purpose, with
     * DIFFERENT `formName` values, and it renders correctly: the component
     * derives its DOM ids from `formName` (`NewsletterSignup.astro:21`), so a
     * second form is only broken when it duplicates the first one's identity.
     * That failure is real and blocks — under `structure_anchor_unique`, which
     * owns DOM-id uniqueness. This rule keeps the useful half: a second form
     * of the same kind is usually an accident, and always worth saying.
     */
    severity: 'warns',
    enforced_live: true,
    description: `At most one each of ${SINGLETON_SECTION_TYPES.join(', ')} per page, counted through shared_ref. A deliberate second one must carry its own formName — duplicate form identities block under structure_anchor_unique.`,
  },
  {
    id: 'structure_adjacency',
    label: 'Adjacent repeats',
    severity: 'warns',
    enforced_live: true,
    description: `No two adjacent sections of the same kind, except ${ADJACENCY_EXEMPT_TYPES.join(' and ')}.`,
  },
  {
    id: 'structure_cta_density',
    label: 'CTA density',
    severity: 'warns',
    enforced_live: true,
    description: `At most ${CTA_DENSITY_MAX} of ${CTA_DENSITY_TYPES.join(', ')} per page.`,
  },
  {
    id: 'structure_anchor_unique',
    label: 'DOM id uniqueness',
    severity: 'blocks_write',
    enforced_live: true,
    description:
      'Section `anchor` values and form `formName` values both become DOM ids within a page and must each be unique: the second one is unreachable, and a duplicated formName breaks that form’s label association and its posting identity.',
  },
  {
    id: 'structure_viewport_budget',
    label: 'Viewport budget',
    severity: 'blocks_publish',
    enforced_live: true,
    description: `Edge-pinned kinds may occupy at most ${VIEWPORT_BUDGET.maxPercentOfSmallViewport}% of a small viewport (xs ${VIEWPORT_BUDGET.percentByHeightClass.xs}%, s ${VIEWPORT_BUDGET.percentByHeightClass.s}%, m ${VIEWPORT_BUDGET.percentByHeightClass.m}%). No kind declares an edge today.`,
  },
];

/**
 * How many pages a shared `section` may render on before `object_patch`
 * reports it as something to notice. Not a limit — sharing is the point — a
 * threshold above which "this edit changes N pages" stops being obvious.
 */
export const SHARED_SECTION_IMPACT_WARN_ABOVE = 5;

export const compositionRule = (id: string): CompositionRule | undefined =>
  COMPOSITION_RULES.find((rule) => rule.id === id);
