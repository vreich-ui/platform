/**
 * Visual standard body schema — 'visual_standard.v1' (brand-imagery wave,
 * BRIEF.md §3.1, R1/R2).
 *
 * A site's image style as a first-class, governed object — the mood-board +
 * writer-proposal record that theme → `site.brandTokens` already mirrors for
 * color: `visual_standard` is the DRAFT/EVOLVED artifact, `site.brandImagery`
 * is the APPLIED copy the privileged `set_site_brand_imagery` op writes (W16
 * C1, site-v1.ts). Applying is a whole-object action (`site_apply_brand_imagery`,
 * §3.3) — this schema never encodes "how to apply," only "what a standard is."
 *
 * `kind: 'house'` is the site's one declared standard (singleton, id
 * `vis_<site>` — the voice_<site>/trk_<site> convention, R2) and never
 * publishable; `kind: 'template'` is an unbounded, ordinary collection of
 * named looks an override can point a run/slot at (id `vis_<site>_<slug>`),
 * living in the SAME object type. See object-verbs.ts SINGLETON_TYPES'
 * `appliesToBody` — only a `kind:'house'` create is singleton-gated; a
 * template create never trips it and vice versa.
 *
 * `brandImagery` is REUSED verbatim from site-v1.ts, never forked: the two
 * fields must never drift, because `set_site_brand_imagery`'s whole-object
 * replace copies a visual_standard's `brandImagery` onto the site as-is.
 * Unlike `site.brandImagery` (privileged-write-only), `brandImagery` HERE is
 * ordinary agent-writable via `set_visual_standard_fields` (object-patch-ops.ts)
 * — the governed thing is the site's APPLIED copy, not the proposal a writer
 * or human is still iterating on.
 *
 * NOT in `governedObjectTypes` (approval-policy.ts) on purpose: `visual_standard`
 * is deliberately outside the generic publish gate — `object_publish` refuses
 * it (`content_item_not_gated`) before it would ever reach a materializer.
 * Applying is the only way a standard's imagery reaches something published
 * (the site), and THAT path (`site_apply_brand_imagery`) is privileged and
 * owner-gated on its own terms.
 *
 * Does NOT carry the shared per-object `tracking` attribute (the
 * tracking_config/editorial_voice precedent, tracking-attribute-v1.ts): a
 * mood board is never a reader-facing, trackable surface.
 */
import { z } from 'zod';

import { brandImagerySchema } from './site-v1.js';

export const VISUAL_STANDARD_SCHEMA_VERSION = 'visual_standard.v1';

const boundedString = (max: number) => z.string().trim().min(1).max(max);

// Region fractions (0..1) — absent = the whole reference image. Mirrors the
// aspect-ratio/brandImagery bounded-fraction posture (site-v1.ts).
const unitFraction = z.number().min(0).max(1);
export const visualStandardRegionSchema = z
  .object({
    x: unitFraction,
    y: unitFraction,
    w: unitFraction,
    h: unitFraction,
  })
  .strict();
export type VisualStandardRegion = z.infer<typeof visualStandardRegionSchema>;

// Opaque, stable reference id — an s_*/t_*-shaped id minted per-reference
// (never a position — a reordered mood board must not silently repoint an
// existing note/weight/region onto a different image).
const REF_ID_RE = /^ref_[a-z0-9]+$/;
export const refIdSchema = z.string().regex(REF_ID_RE, { message: 'Reference ids must match ref_<lowercase alphanumerics>' });

/**
 * One mood-board entry. `weight` is the Midjourney `--sw` analogue (style
 * weight, default 1 when omitted); `note` is deliberately scoped to "the
 * palette, not the subject" — the same subject/style separation R4 enforces
 * at the prompt-assembly boundary.
 */
export const visualStandardReferenceSchema = z
  .object({
    id: refIdSchema,
    blobKey: boundedString(500),
    region: visualStandardRegionSchema.optional(),
    note: boundedString(200).optional(),
    weight: z.number().min(0).max(1).optional(),
  })
  .strict();
export type VisualStandardReference = z.infer<typeof visualStandardReferenceSchema>;

/** W5, generated: a rendered example tying one usage context to its artifact. */
export const visualStandardExampleSchema = z
  .object({
    usageContext: boundedString(80),
    blobKey: boundedString(500),
    contractHash: boundedString(128),
  })
  .strict();
export type VisualStandardExample = z.infer<typeof visualStandardExampleSchema>;

export const visualStandardDerivedFromSchema = z
  .object({
    visualStandardId: boundedString(120).optional(),
    themeId: boundedString(120).optional(),
    method: z.enum(['writer', 'tokens', 'manual', 'clone']),
  })
  .strict();
export type VisualStandardDerivedFrom = z.infer<typeof visualStandardDerivedFromSchema>;

/**
 * The SHAPE alone — field types, strictness, id regexes — without the
 * status/sampleSubjects invariant below. Split out for the SAME reason
 * `editorialVoiceShapeSchema` is (editorial-voice-v1.ts): zod refuses
 * `.partial()` on an object schema carrying its own `.refine()`, and the
 * Ask-AI derivation (`ask-ai-schema.ts`) partials every registered body
 * schema to build its suggestion tool. That is the right semantics anyway —
 * a PARTIAL body cannot satisfy a status-conditioned invariant (the partial
 * may contain neither key) — so asserting it there would reject every
 * legitimate suggestion. The whole-body invariant belongs to the whole body.
 * Enforcement is unaffected: every write path (`object_create`,
 * `object_patch`, `object_validate`, the materializer, the
 * `apply_brand_imagery` verb) uses `visualStandardBodySchema` below, never
 * this one directly.
 */
export const visualStandardShapeSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['house', 'template']),
    label: boundedString(80),
    description: boundedString(400).optional(),
    // Agent-facing (templates): the field that makes a set of named looks
    // decidable when an override picks between siblings — the same
    // whenToUse idiom recipes (template/section_template/theme) use.
    whenToUse: boundedString(400).optional(),
    // REUSED verbatim from site-v1.ts (site-v1.ts:141) — never forked. Ordinary
    // agent-writable HERE (unlike site.brandImagery, which is privileged-write
    // only): the governed thing is the site's applied copy, not this proposal.
    brandImagery: brandImagerySchema,
    // The mood board, max 24 (R-bounded, "nothing unbounded lands in the store").
    references: z.array(visualStandardReferenceSchema).max(24),
    // Subject-only prompts used for examples — never style words (R4).
    // FIX-E: the static floor used to be min(1) unconditionally, which meant
    // a freshly cloned DRAFT standard (CMS-Agent's clone engine,
    // `derivedFrom.method:'clone'`) could never even be CREATED — a page
    // snapshot can say what a picture looks like, never what it is OF, so
    // the clone deliberately omits sampleSubjects rather than inventing
    // subjects nobody asked for. The floor moves to `visualStandardBodySchema`'s
    // `.refine` below, conditioned on status, so a draft may start empty
    // while `active` (and `archived`, which was active once) still requires
    // 1..6. The bound that never depends on status — max 6 — stays a plain
    // array constraint, right here in the shape.
    sampleSubjects: z.array(boundedString(300)).max(6),
    // W5, last: generated behind everything functional (R9). Bounded
    // defensively even though the interface freeze names no cap.
    examples: z.array(visualStandardExampleSchema).max(100).optional(),
    derivedFrom: visualStandardDerivedFromSchema.optional(),
    status: z.enum(['draft', 'active', 'archived']),
  })
  .strict();

/**
 * The enforced body: shape + the whole-body invariant. Every write path uses
 * THIS (see the shape schema's own comment for why Ask-AI's tool derivation
 * uses the unrefined shape instead).
 *
 * FIX-E: a standard must not be able to REACH active with no sample
 * subjects — a patch that flips status without ever adding one is refused
 * here exactly like a create would be, because both re-validate the whole
 * resulting body against this schema (object-patch-apply.ts: "a resulting
 * body that fails validation rejects the op without persisting"). Applying
 * is guarded separately, at the site-checkout boundary
 * (object-verbs.ts's `apply_brand_imagery` case) — see that file's own
 * comment for why sampleSubjects needs its OWN check there too, not just
 * this one.
 */
export const visualStandardBodySchema = visualStandardShapeSchema.refine(
  (body) => body.status === 'draft' || body.sampleSubjects.length >= 1,
  {
    message: 'sampleSubjects needs 1..6 entries once a standard is active or archived — only a draft may start empty.',
    path: ['sampleSubjects'],
  }
);
export type VisualStandardBody = z.infer<typeof visualStandardBodySchema>;
