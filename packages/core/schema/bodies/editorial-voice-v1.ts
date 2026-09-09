/**
 * Editorial voice body schema — 'editorial_voice.v1' (D1, 2026-07-28).
 *
 * The twelfth governed object type, and the first one whose reader is an AGENT
 * rather than a renderer. A voice is the site's DECLARED editorial identity:
 * who it speaks to, how it sounds, what it may claim, what it may ask for, and
 * which named article frameworks are legitimate on this site. Nothing about a
 * voice reaches a page — it materializes to the export tree so the engine can
 * read it as governed data, and no Astro route ever consumes it.
 *
 * ONE PER SITE, id `voice_<site>` (the site_/tax_/trk_ singleton convention).
 * Reachable through the ordinary object surface — `object_contract('editorial_voice')`
 * then `object_get('voice_platform')` — precisely so no engine needs a private
 * side-channel to learn a client's voice. That was the whole argument for making
 * it an object instead of a prompt fragment: it is versioned, approvable,
 * diffable and lock-governed like every other governed surface.
 *
 * DATA, NOT INSTRUCTIONS. Every field describes what the voice IS, in the third
 * person, as a fact about the publication. A field carrying prompt-formatted
 * text ("You are an expert…", "Your task is…", chat-turn markers, {{templates}})
 * is refused at write by the `voice_not_a_prompt` constraint — see
 * ../../lib/registry/voice-prose.ts for the enforced marker catalog. The reason
 * is governance, not taste: a prompt smuggled into a governed object is an
 * unreviewable instruction to whichever model reads it next, and the approval
 * that covered "the voice" would silently have covered an injection.
 *
 * `frameworks[]` is PLURAL with a declared `default_framework`: a site's article
 * shapes are a bounded named set (an explainer is not a review is not a
 * teardown), and pinning exactly one framework per site was the modelling error
 * this type exists to avoid. W-D6 layers the cross-object rule on top — a
 * content_item's `editorial.framework` must name a framework THIS site declares.
 *
 * Does NOT carry the per-object `tracking` attribute (the tracking_config
 * precedent): a voice is never a tracked surface, it is authoring law.
 */
import { z } from 'zod';

import { baselineProvenanceSchema } from './baseline-provenance-v1.js';

export const EDITORIAL_VOICE_SCHEMA_VERSION = 'editorial_voice.v1';

/** Opaque, stable framework id — renaming a label must not break references. */
export const frameworkIdSchema = z.string().regex(/^fw_[a-z0-9]+(?:_[a-z0-9]+)*$/, {
  message: 'Framework ids must match fw_<lowercase alphanumerics, underscore-separated>',
});

/**
 * One named article shape this site publishes. `when_to_use` is the field that
 * makes the set decidable by an agent choosing between siblings — the same
 * reuse-first idiom the recipe types' whenToUse serves.
 */
export const editorialFrameworkSchema = z
  .object({
    framework_id: frameworkIdSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    when_to_use: z.string().min(1),
    /** Ordered section beats this framework expects, as reader-facing names. */
    beats: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type EditorialFramework = z.infer<typeof editorialFrameworkSchema>;

export const voiceLexiconSchema = z
  .object({
    /** Vocabulary this publication reaches for. */
    prefer: z.array(z.string().min(1)).default([]),
    /** Vocabulary this publication refuses — the harder half of a house style. */
    avoid: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type VoiceLexicon = z.infer<typeof voiceLexiconSchema>;

/**
 * The SHAPE alone — field types, strictness, id regexes — without the
 * cross-field invariants below. Split out because zod refuses `.partial()` on a
 * schema carrying refinements, and the Ask-AI derivation partials every body
 * schema to build its suggestion tool. That is the right semantics anyway: a
 * PARTIAL body cannot satisfy "default_framework ∈ frameworks[]" (the partial
 * may contain neither key), so asserting it there would reject every legitimate
 * suggestion. The whole-body invariants belong to the whole body.
 * Enforcement is unaffected: every write path validates `editorialVoiceBodySchema`.
 */
export const editorialVoiceShapeSchema = z
  .object({
    name: z.string().min(1),
    /** Who this publication is written for, stated as a fact about the reader. */
    audience: z.string().min(1),
    /** Tone adjectives — the fast, checkable half of "how it sounds". */
    tone: z.array(z.string().min(1)).min(1),
    /** Sentence and paragraph rhythm: length, density, person, tense. */
    cadence: z.string().min(1),
    lexicon: voiceLexiconSchema,
    /** What this publication may assert, and what evidence a claim needs. */
    claim_policy: z.string().min(1),
    /** What this publication may ask a reader to do, and how directly. */
    cta_policy: z.string().min(1),
    /** Reader-harm boundaries specific to this audience (medical, financial, minors …). */
    reader_safety_notes: z.string().min(1),
    frameworks: z.array(editorialFrameworkSchema).min(1),
    /** Must name one of `frameworks[]` — the shape used when nothing else is chosen. */
    default_framework: frameworkIdSchema,
    /**
     * The unset marker (Wolf, 2026-09-09) — see baseline-provenance-v1.ts.
     * OPTIONAL here and required on `editorial_strategy`, because voices
     * existed before the marker did: absence means "written before this block
     * existed", which is an AUTHORED voice, so readers treat a missing
     * provenance as `human` and never as a seeded default. Genesis writes
     * `genesis_default` when it seeds a voice nobody supplied (W2), and that
     * is the one value that makes `getEditorialVoice` report
     * `voice_object_unconfigured`.
     */
    provenance: baselineProvenanceSchema.optional(),
  })
  .strict();

/**
 * The enforced body: shape + the whole-body invariants. Every write path
 * (object_create, object_patch, object_validate, the materializer) uses THIS.
 */
export const editorialVoiceBodySchema = editorialVoiceShapeSchema.superRefine((body, ctx) => {
  const ids = body.frameworks.map((framework) => framework.framework_id);
  // A default pointing at nothing is the failure mode that makes "plural
  // frameworks with a declared default" worse than a single pinned framework:
  // the engine would silently fall through to no shape at all.
  if (!ids.includes(body.default_framework)) {
    ctx.addIssue({
      code: 'custom',
      path: ['default_framework'],
      message: `default_framework "${body.default_framework}" is not one of frameworks[] (${ids.join(', ') || 'none'}).`,
    });
  }
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['frameworks'],
      message: `Duplicate framework_id(s): ${[...new Set(duplicates)].join(', ')}.`,
    });
  }
});

export type EditorialVoiceBody = z.infer<typeof editorialVoiceBodySchema>;
