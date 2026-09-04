/**
 * The aggression scorer (W7.3) — server-side enforcement of the per-site
 * ceiling, for ANY actor.
 *
 * WHAT WAS WRONG. The aggression ceiling is the client's standing instruction
 * about how hard their copy may push, and until now it was enforced in exactly
 * one place: the CMS-Agent workflow, which clamps each dial to
 * `min(placement_target, ceiling)` while composing. A plugin publishing over
 * `/mcp` never touches that path. The rendered skill therefore states the
 * ceiling as prose and asks the model to obey it — which is to say the ceiling
 * held for as long as a language model remembered a paragraph. The same wave
 * that proved `agent_name` cannot be trusted to a model's memory
 * (caller-surface.ts's sixteen unattributed calls) applies here: prose loses.
 *
 * So the ceiling is checked where every actor passes — `object_validate`, and
 * therefore the publish gate — and it is checked from the BODY, not from a
 * number the writer supplies about itself.
 *
 * WHY DETERMINISTIC, AND WHY LEXICAL. Two properties matter more than
 * sophistication:
 *
 *  - The same article scores the same on every run, on every deploy, with no
 *    network call and no model. A gate whose verdict moves under a writer is
 *    not a gate, it is a hazard; and a gate that costs a model call cannot run
 *    on every `object_validate`.
 *  - The score can SAY WHY. Every point comes from a phrase at a node, and the
 *    result names them, so "lower the urgency" is actionable rather than
 *    mystical.
 *
 * The cost is honest and stated on the tin: this measures the MARKETING
 * REGISTER, not meaning. It cannot tell an ironic "miracle cure" from a sincere
 * one, and it will not catch aggression carried purely by structure. It is a
 * floor under the prose instruction, not a replacement for editorial judgment
 * — which is exactly why the first band is a WARNING and only sustained excess
 * blocks.
 *
 * WHY THE LEXICONS ARE PHRASES, NOT WORDS. The first draft of this keyed on
 * single words — "now", "never", "proven", "always" — and every calm article in
 * the corpus lit up: "now that you know", "retinoids never suit everyone",
 * "proven in trials", "always patch test". Ordinary English is not aggression.
 * What distinguishes pushy copy is a commercial register: scarcity framing,
 * absolute promises, shame, and stacked calls to action. Every entry below is
 * a phrase (or a word that has no calm reading in body copy), and the corpus
 * test at tests/netlify/aggression-score.test.ts holds every real published
 * article to a pass.
 */
import { AGGRESSION_CEILING_DIALS, type AggressionCeiling } from '../../lib/site-identity.js';

export type AggressionDial = (typeof AGGRESSION_CEILING_DIALS)[number];
export type AggressionScore = Record<AggressionDial, number>;

/** One phrase, where it was found. Bounded in the result — this is evidence, not a concordance. */
export type AggressionHit = { dial: AggressionDial; term: string; node_id: string };

export type AggressionEvaluation = {
  score: AggressionScore;
  /** score ÷ ceiling, per dial. 1.0 is exactly at the ceiling. */
  ratio: Record<AggressionDial, number>;
  /** The dial that is furthest over, or null when nothing exceeds the ceiling. */
  worst: { dial: AggressionDial; ratio: number } | null;
  hits: AggressionHit[];
  /** Denominators, so a surprising score can be reasoned about rather than argued with. */
  basis: { words: number; public_nodes: number; cta_nodes: number };
};

/**
 * Per-site tolerance around the ceiling. Defaults chosen deliberately:
 *
 *   warn at 1.00 — the ceiling is a ceiling. Reaching it is worth saying.
 *   block at 1.15 — a 15% band above it, because this scorer is a proxy and a
 *   proxy should not stop a publish over a rounding-width disagreement. Past
 *   that, the copy is not near the ceiling, it is over it.
 */
export type AggressionTolerance = { warn: number; block: number };
export const DEFAULT_AGGRESSION_TOLERANCE: AggressionTolerance = { warn: 1.0, block: 1.15 };

/**
 * Saturation points: the rate at which a dial reads 1.0.
 *
 * Expressed per 1,000 words (or, for CTAs, as a share of public nodes) so the
 * score is a DENSITY and a long article is not penalised for being long. The
 * numbers are calibrated against the drlurie corpus — every published article
 * scores well under its ceiling — and against hand-written copy at the three
 * bands the fixtures pin.
 */
const SATURATION = {
  /** Absolute/commercial claims per 1,000 words. */
  claim_strength: 10,
  /** Scarcity and time-pressure phrases per 1,000 words. These are rare in calm copy. */
  urgency: 5,
  /** Fear / shame / FOMO phrases (plus exclamation marks) per 1,000 words. */
  emotional_agitation: 8,
  /**
   * Share of public nodes that ASK THE READER FOR SOMETHING. Saturation is 1.0
   * — that is, the dial IS the share, not a rescaling of it. The ceiling's
   * `cta_density: 0.20` then reads exactly as an editor would say it: "at most
   * one block in five may be a call to action". Any other saturation makes the
   * number in the site config mean something no one can state in a sentence,
   * and the first calibration pass (0.35) failed the live corpus for precisely
   * that reason — a thirteen-block article with one PDF offer scored 220%.
   */
  cta_density: 1,
} as const;

/**
 * Hedging damps the claim dial rather than scoring its own axis: "may help
 * some people" and "eliminates wrinkles" are the same sentence shape carrying
 * opposite force, and a scorer that counted only the second would read a
 * carefully qualified article as loudly as an unqualified one. Capped at half,
 * because no amount of hedging makes "guaranteed to cure" calm.
 */
const HEDGE_SATURATION = 12;
const MAX_HEDGE_DAMPING = 0.5;

/**
 * The smallest denominator `cta_density` will divide by.
 *
 * A share is meaningless on a stub. A three-block fixture with one call to
 * action scores 33% and reads as twice as pushy as the same CTA in a finished
 * six-block article — which is not a fact about the copy, it is an artefact of
 * the denominator. Two existing suites caught this immediately: a media-type
 * fixture and an ART-2 sourcing fixture, both two- and three-node articles
 * carrying one ordinary CTA, both blocked.
 *
 * Five is not a round number chosen for comfort: it is the ceiling's OWN
 * arithmetic. `cta_density: 0.20` means "one block in five", so one CTA in an
 * article of five blocks or fewer sits exactly AT the ceiling and passes,
 * while a second one in the same space is over it. The floor makes short
 * articles judged by the rule the ceiling states rather than by their length.
 */
const MIN_CTA_DENOMINATOR = 5;

/**
 * The smallest word count the per-1,000-word rates will divide by.
 *
 * Same defect as the CTA denominator, on the lexical dials. A six-word probe
 * body — "Retinol reverses wrinkles in 7 days." — carries one flagged phrase
 * and, divided by six words, scores a saturated 1.00: a stub reads as the most
 * aggressive copy the scorer can imagine. Density is an estimate, and an
 * estimate from six words is noise, not evidence.
 *
 * 200 words is roughly the shortest thing this publication ships as an article
 * (the shortest in the live corpus is 153). Below it the rate is computed as
 * though the piece ran to 200, which keeps a short article measurable while
 * refusing to let one phrase in a fragment saturate a dial.
 */
const MIN_RATE_WORDS = 200;

/** Word-boundary matching, case-insensitive, on normalized text. */
const phrase = (source: string): RegExp => new RegExp(`(?<![a-z0-9])${source}(?![a-z0-9])`, 'gi');

/**
 * Absolute and commercial claim phrases. Every entry is a promise a cautious
 * editorial voice would qualify; none of them has a calm reading in body copy.
 */
const CLAIM_TERMS = [
  'guaranteed',
  'guarantee results',
  'clinically proven',
  'scientifically proven',
  'proven to (?:cure|erase|eliminate|reverse|stop)',
  'cures?\\b',
  'eliminates?',
  'erases?',
  'reverses (?:ageing|aging|wrinkles|damage)',
  'permanently',
  'instantly',
  'overnight results',
  'miracle',
  'breakthrough',
  'revolutionary',
  '100 ?%',
  'number one',
  'the only (?:product|cream|serum|solution|thing that)',
  'works for everyone',
  'every single',
  'no side effects',
  'zero side effects',
  'risk[- ]free',
  'doctors? (?:agree|recommend)',
  'dermatologists? (?:agree|recommend)',
];

/** Qualifiers a careful voice uses. Presence damps the claim dial. */
const HEDGE_TERMS = [
  'may',
  'might',
  'can help',
  'tends? to',
  'often',
  'usually',
  'typically',
  'in some people',
  'for many people',
  'evidence suggests',
  'studies suggest',
  'is not a cure',
  'no single',
  'depends on',
  'varies',
  'if it suits',
  'some skin',
];

/**
 * Scarcity and time pressure. Note what is NOT here: bare "now", "today",
 * "immediately". Those are ordinary English ("now that you know", "what we know
 * today") and counting them made every calm article read as urgent.
 */
const URGENCY_TERMS = [
  'act (?:now|fast|today)',
  '(?:buy|order|shop|claim|start) now',
  'limited time',
  'limited (?:stock|supply|availability)',
  'while (?:stocks|supplies) last',
  "(?:don'?t|do not) (?:wait|miss)",
  'last chance',
  'final (?:call|chance|hours?|days?)',
  'ends? (?:soon|tonight|today)',
  'expires? (?:soon|today|tonight)',
  'today only',
  'only \\d+ (?:left|remaining|spots?|places?)',
  'hurry',
  "before it(?:’|')?s too late",
  'time is running out',
  'selling out',
  'going fast',
];

/**
 * Fear, shame and FOMO — aimed at the reader's standing, not at the subject.
 * "Damage" and "irritation" are absent on purpose: they are the vocabulary of
 * the subject matter, and a skincare publication cannot discuss barrier damage
 * without saying "damage".
 */
const AGITATION_TERMS = [
  'embarrassing',
  'embarrassed',
  'ashamed',
  'shameful',
  'humiliat\\w*',
  'ugly',
  'disgusting',
  'nobody wants',
  'no one wants',
  'everyone (?:else )?(?:is|has|knows)',
  'falling behind',
  'fall behind',
  'missing out',
  'miss out',
  "you(?:’|')?ll regret",
  'you will regret',
  'ruining your',
  'destroying your',
  'wasting your',
  "you(?:’|')?re (?:doing it wrong|failing)",
  'stop (?:ruining|destroying|wasting)',
  'terrified',
  'desperate',
  'suffer\\w*',
  'disaster',
  'nightmare',
];

/** Imperative CTA phrasing, counted wherever it appears — including inside a content node. */
const CTA_TERMS = [
  'buy (?:now|today|it)',
  'shop (?:now|the|our)',
  'order (?:now|today|yours)',
  'add to (?:cart|basket|bag)',
  'sign up',
  'subscribe',
  'join (?:now|today|us)',
  'get yours',
  'claim your',
  'click here',
  'tap here',
  'download (?:the|your|now)',
  'book (?:now|a call|your)',
  'start your (?:free )?trial',
  'grab (?:it|yours)',
];

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Strip tags and entities so lexical matching sees the words a reader sees. */
export const plainText = (value: string): string =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

type TextUnit = { nodeId: string; text: string };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const pushString = (into: TextUnit[], nodeId: string, value: unknown): void => {
  if (typeof value !== 'string') return;
  const text = plainText(value);
  if (text) into.push({ nodeId, text });
};

/**
 * Every string a READER sees, keyed by the node it came from.
 *
 * `private` is deliberately excluded. It holds the strategy annotations
 * (`hook`, `agitation`, `intent: 'convert'`) — naming a beat is not performing
 * it, and scoring the annotation would punish an article for being honest about
 * its own structure, which is the one thing this model asks writers to be.
 * Internal and hidden nodes are excluded for the same reason they are excluded
 * from rendering: nobody reads them.
 */
export const readerText = (body: unknown): { units: TextUnit[]; publicNodes: number; ctaNodes: number } => {
  const record = asRecord(body);
  const units: TextUnit[] = [];
  if (!record) return { units, publicNodes: 0, ctaNodes: 0 };

  for (const field of ['title', 'deck', 'description'] as const) {
    pushString(units, '<envelope>', record[field]);
  }

  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  let publicNodes = 0;
  let ctaNodes = 0;

  for (const raw of nodes) {
    const node = asRecord(raw);
    if (!node) continue;
    const visibility = typeof node.visibility === 'string' ? node.visibility : 'public';
    if (visibility !== 'public') continue;
    publicNodes += 1;

    const nodeId = typeof node.id === 'string' ? node.id : '<node>';
    const pub = asRecord(node.public) ?? {};

    for (const field of ['eyebrow', 'title', 'body', 'label', 'ctaText'] as const) {
      pushString(units, nodeId, pub[field]);
    }
    if (Array.isArray(pub.items)) for (const item of pub.items) pushString(units, nodeId, item);

    /**
     * A node counts as a CTA ONCE, however many ways it announces itself: an
     * `action` node, a pressable link, or imperative CTA phrasing in its own
     * text. Counting the structure and the phrase separately double-charged
     * every honest CTA — an action node whose button reads "Download the PDF
     * guide" scored as two — which is how the live moisturizer article came out
     * at 220% of a ceiling it plainly respects.
     */
    const nodeText = [pub.eyebrow, pub.title, pub.body, pub.label, pub.ctaText]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    const asksForSomething =
      node.kind === 'action' ||
      typeof pub.ctaLink === 'string' ||
      CTA_TERMS.some((term) => phrase(term).test(plainText(nodeText)));
    if (asksForSomething) ctaNodes += 1;
  }

  return { units, publicNodes, ctaNodes };
};

const countMatches = (
  units: readonly TextUnit[],
  terms: readonly string[],
  dial: AggressionDial,
  hits: AggressionHit[]
): number => {
  let total = 0;
  for (const term of terms) {
    const pattern = phrase(term);
    for (const unit of units) {
      pattern.lastIndex = 0;
      for (const match of unit.text.matchAll(pattern)) {
        total += 1;
        // Bounded: the first 25 are evidence, the rest are the same story.
        if (hits.length < 25) hits.push({ dial, term: match[0].toLowerCase(), node_id: unit.nodeId });
      }
    }
  }
  return total;
};

const countExclamations = (units: readonly TextUnit[]): number =>
  units.reduce((total, unit) => total + (unit.text.match(/!/g)?.length ?? 0), 0);

const wordCount = (units: readonly TextUnit[]): number =>
  units.reduce((total, unit) => total + (unit.text.match(/\S+/g)?.length ?? 0), 0);

/**
 * Score an article body on the four dials.
 *
 * Pure and synchronous: no store, no network, no clock. `object_validate` runs
 * on every patch, so anything else would be unaffordable.
 */
export const scoreAggression = (body: unknown): Omit<AggressionEvaluation, 'ratio' | 'worst'> => {
  const { units, publicNodes, ctaNodes } = readerText(body);
  const hits: AggressionHit[] = [];
  const words = wordCount(units);

  // A body with no reader-facing prose has nothing to be aggressive with.
  if (words === 0) {
    return {
      score: { claim_strength: 0, urgency: 0, emotional_agitation: 0, cta_density: 0 },
      hits,
      basis: { words: 0, public_nodes: publicNodes, cta_nodes: ctaNodes },
    };
  }

  const perThousand = (count: number) => (count / Math.max(words, MIN_RATE_WORDS)) * 1000;

  const claims = countMatches(units, CLAIM_TERMS, 'claim_strength', hits);
  const hedges = countMatches(units, HEDGE_TERMS, 'claim_strength', []);
  const hedgeDamping = 1 - MAX_HEDGE_DAMPING * clamp01(perThousand(hedges) / HEDGE_SATURATION);
  const claimStrength = clamp01((perThousand(claims) / SATURATION.claim_strength) * hedgeDamping);

  const urgency = clamp01(perThousand(countMatches(units, URGENCY_TERMS, 'urgency', hits)) / SATURATION.urgency);

  const agitationCount = countMatches(units, AGITATION_TERMS, 'emotional_agitation', hits) + countExclamations(units);
  const emotionalAgitation = clamp01(perThousand(agitationCount) / SATURATION.emotional_agitation);

  /**
   * The share of the article's blocks that ask the reader for something. A
   * five-block article with two CTAs is pushing harder than a fifty-block
   * article with the same two, which is why this is a share and not a count.
   * An envelope-only body has no blocks and therefore no density.
   *
   * `countMatches` still runs, but only to collect EVIDENCE: the phrases are
   * what the criterion quotes back when the dial is over, and the count itself
   * comes from `readerText`'s per-node tally above.
   */
  countMatches(units, CTA_TERMS, 'cta_density', hits);
  const ctaDensity =
    publicNodes === 0 ? 0 : clamp01(ctaNodes / Math.max(publicNodes, MIN_CTA_DENOMINATOR) / SATURATION.cta_density);

  return {
    score: {
      claim_strength: claimStrength,
      urgency,
      emotional_agitation: emotionalAgitation,
      cta_density: ctaDensity,
    },
    hits,
    basis: { words, public_nodes: publicNodes, cta_nodes: ctaNodes },
  };
};

/**
 * Score a body and compare it to a ceiling.
 *
 * A dial whose ceiling is 0 is treated as "any measurable value exceeds it" —
 * a site that declares `urgency: 0` means no urgency, and dividing by zero to
 * get Infinity says exactly that.
 */
export const evaluateAggression = (body: unknown, ceiling: AggressionCeiling): AggressionEvaluation => {
  const scored = scoreAggression(body);
  const ratio = {} as Record<AggressionDial, number>;
  let worst: AggressionEvaluation['worst'] = null;

  for (const dial of AGGRESSION_CEILING_DIALS) {
    const limit = ceiling[dial];
    const value = scored.score[dial];
    const dialRatio = limit > 0 ? value / limit : value > 0 ? Number.POSITIVE_INFINITY : 0;
    ratio[dial] = dialRatio;
    if (!worst || dialRatio > worst.ratio) worst = { dial, ratio: dialRatio };
  }

  return { ...scored, ratio, worst: worst && worst.ratio > 0 ? worst : null };
};

/** Percentage-of-ceiling, for a message a human reads. `Infinity` prints as "over". */
export const formatRatio = (ratio: number): string =>
  Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : 'over a zero ceiling';
