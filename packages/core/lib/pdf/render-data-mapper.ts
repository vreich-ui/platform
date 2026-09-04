/**
 * content_item → PDF render data (W2 T2.1, ruling D-C).
 *
 * ROOT CAUSE #2 of the 2026-09-03 garbage PDF: nothing on the plugin `/mcp`
 * path turned an article into render data. An agent hand-authored `data`,
 * guessed the template's slots, and posted site-relative `/img/…` paths into
 * them. The render service cannot fetch a site-relative path — every image
 * came out a broken box — and the object it dropped into a string slot
 * printed as `[object Object]`. CMS-Agent has a deterministic mapper in its
 * own workflow plane; the plugin path cannot reach it. This is that mapper,
 * in platform, where both paths can reach it.
 *
 * THE MODULE IS PURE. No fetch, no blob read, no store, no clock, no model.
 * Same article in, same bytes out, forever. That is what makes it testable
 * under `npm test` (this repo's whole test posture — see BRIEF §4) and what
 * lets cms-agent adopt it later without dragging platform's I/O along. The
 * fetching — the content item, the site, the template's own
 * `renderDataSchema` — belongs to the caller (`build_pdf_render_data` in
 * mcp-tool-handlers.ts, and the bridge's own `data`-omitted path).
 *
 * THE IMAGE CONVERSION IS THE POINT. Every image an article carries is a
 * public artifact path, `/img/<requestId>/<sha256>.<ext>` (artifact-trust.ts).
 * pdf-tool serves job assets — and ONLY job assets — from
 * `https://render.assets.invalid/<assetId>`, resolving each `assets.images[]`
 * entry's `blobKey` to bytes. So an image reaches a PDF only as the PAIR
 * ({ assetId, blobKey } in `assets.images[]`, the bare `assetId` in the data
 * slot). A `/img/…` left in a data slot is exactly what W1's `ASSET_MISSING`
 * now fails the whole render on, so an image whose src is not a recognizable
 * artifact path is reported in `unfilled[]` and its figure is omitted —
 * never emitted as an unfetchable value that takes the render down with it.
 *
 * THE LEAK RULE. Nothing from the annotation layer may reach `data`: not
 * `node.private`, not `node.commercial`, not `editorial` / `scores` /
 * `claims` / `emotional_strategy`. A PDF is reader-facing output. This is
 * enforced by CONSTRUCTION, not by filtering: every read below names an
 * explicit reader-facing field (`public.title`, `public.body`,
 * `public.media`, the envelope's own title/deck/author/image/taxonomy/
 * sources), and there is no passthrough of anything else anywhere in the
 * file. A test asserts it on real annotated input.
 *
 * WHAT IT REFUSES TO DO. It never invents. No fabricated pull quote picked
 * out of a sentence (an empty array is honest, and the schema allows it), no
 * fabricated disclaimer or footer note (those are the caller's or the site's),
 * no fabricated `brand` (pdf-render-brand.ts owns that shape and the bridge
 * injects it; a brand passed in here is passed straight through, untouched).
 * What it could not fill, it says, in `unfilled[]`.
 */
import { BLOCKS, INLINES } from '@contentful/rich-text-types';

import { ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA } from './article-brochure-v1-render-data-schema.js';

// ── the public shape ─────────────────────────────────────────────────────────

/** One job asset: the id a data slot names, and the artifact key behind it. */
export type RenderDataAssetImage = { assetId: string; blobKey: string };

export type RenderDataSection = {
  heading: string;
  paragraphs: string[];
  figure?: { assetId: string; caption?: string };
};

export type RenderDataPullQuote = { quote: string; attribution?: string };

export type RenderDataSource = { label: string; url?: string; note?: string };

/**
 * The render `data` object. `brand` is present only when the caller passed
 * one — this module never builds a brand (see the module comment).
 */
export type RenderData = {
  brand?: unknown;
  title?: string;
  deck?: string;
  kicker?: string;
  author?: string;
  date?: string;
  coverImage?: string;
  sections: RenderDataSection[];
  pullQuotes: RenderDataPullQuote[];
  sources: RenderDataSource[];
};

export type BuildRenderDataResult = {
  data: RenderData;
  assets: { images: RenderDataAssetImage[] };
  /** Stable, greppable codes for everything the article could not fill. */
  unfilled: string[];
};

export type BuildRenderDataOptions = {
  /**
   * The target template's `renderDataSchema`, as the pdf-tool template record
   * carries it. Supplies the slot set and the limits; anything it does not
   * declare is not emitted (these schemas are `additionalProperties: false`,
   * so an undeclared slot fails the whole render). Omitted ⇒
   * `article_brochure_v1`'s contract, read through the same code path.
   */
  templateSchema?: unknown;
  /**
   * A `brand` block built by pdf-render-brand.ts. Passed through verbatim,
   * never constructed and never inspected — that module owns the shape, and
   * the bridge owns when it fires (D-3).
   */
  brand?: unknown;
};
//
// DELIBERATELY NOT AN OPTION: the artifact `kind` (`article` / `lead_magnet` /
// `sales_brochure`). It is `site.pdf.byKind`'s key — a routing token that
// picks the TEMPLATE, which is the caller's decision before it ever gets
// here, and once a template is chosen the kind tells this module nothing it
// does not already read off the article. The one place it could plausibly
// land — `kicker` — is reader-facing text on a cover page, and "lead_magnet"
// is platform vocabulary, not something a reader should ever see. An option
// this module would only ignore is worse API than no option.

// ── unfilled[] vocabulary ────────────────────────────────────────────────────
//
// `unfilled[]` is a first-class output: it is what tells an agent, and the
// admin PDF card, WHY a PDF came out thin. Entries are `<code>:<slot>` or
// `<code>:<slot>:<nodeId>`, lowercase snake, stable, and safe to show to an
// agent or an editor — node ids are opaque by schema (they may not contain
// strategy words) and slot names are template vocabulary. NOTHING here ever
// carries a tenant path, a blobKey or a blob sha: blobKeys live in
// `assets.images[]`, which is machine plumbing, not readable text.
export const UNFILLED_CODES = [
  /** A slot the article carries nothing for. `missing:<slot>` */
  'missing',
  /** A node that is not article prose. `skipped_node:<kind|non_public>:<nodeId>` */
  'skipped_node',
  /** A node whose prose came out empty. `empty_section:<nodeId>` */
  'empty_section',
  /** Attached media that is not a figure. `skipped_media:<mediaType>:<nodeId>` */
  'skipped_media',
  /** An image src that is not a convertible artifact path. `unconvertible_image:<slot>[:<nodeId>]` */
  'unconvertible_image',
  /** A figure with nowhere to go (one figure per section). `dropped_figure:<nodeId>` */
  'dropped_figure',
  /** A hyperlink flattened to its text — the template has no link slot. `dropped_link:<nodeId>` */
  'dropped_link',
  /** A rich-text embed this pure module cannot resolve. `unresolved_embed:<nodeId>` */
  'unresolved_embed',
  /** Content past a schema cap. `dropped_section:<i>` / `dropped_source:<i>` / `dropped_pull_quote:<i>` */
  'dropped_section',
  'dropped_source',
  'dropped_pull_quote',
  /** A string cut to the schema's maxLength. `truncated:<slot>[:<nodeId>]` */
  'truncated',
  /** Content the TARGET schema has no slot for. `unsupported_slot:<slot>` */
  'unsupported_slot',
] as const;

// ── small helpers ────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);

/** A trimmed, non-empty string, or undefined. Never `String(anObject)`. */
const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

/** Collapse the interior whitespace of one paragraph, exactly as HTML would. */
const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

// ── the target schema's limits ───────────────────────────────────────────────
//
// Read, never assumed: the SAME reader runs over a caller-supplied schema and
// over the mirrored article_brochure_v1 default, so the two cannot drift. A
// schema that does not declare a limit leaves that limit unbounded rather
// than inheriting a guess from somewhere else.

type RenderDataLimits = {
  slots: Set<string>;
  assetIdPattern: RegExp;
  maxTitle?: number;
  maxDeck?: number;
  maxKicker?: number;
  maxAuthor?: number;
  maxDate?: number;
  maxSections?: number;
  maxHeading?: number;
  maxParagraphs?: number;
  maxParagraph?: number;
  maxCaption?: number;
  maxPullQuotes?: number;
  maxQuote?: number;
  maxAttribution?: number;
  maxSources?: number;
  maxSourceLabel?: number;
  maxSourceUrl?: number;
  maxSourceNote?: number;
};

/** Follow a local `$ref` (`#/$defs/x`) one hop; returns the node itself otherwise. */
const deref = (schema: Record<string, unknown>, node: unknown): Record<string, unknown> | undefined => {
  const asRecord = record(node);
  if (!asRecord) return undefined;
  const ref = text(asRecord.$ref);
  if (!ref || !ref.startsWith('#/$defs/')) return asRecord;
  const defs = record(schema.$defs);
  return record(defs?.[ref.slice('#/$defs/'.length)]);
};

const maxLengthOf = (schema: Record<string, unknown>, node: unknown): number | undefined =>
  positiveInt(deref(schema, node)?.maxLength);

const propertyOf = (
  schema: Record<string, unknown>,
  node: Record<string, unknown> | undefined,
  name: string
): Record<string, unknown> | undefined => deref(schema, record(node?.properties)?.[name]);

export const readRenderDataLimits = (templateSchema: unknown): RenderDataLimits => {
  const schema = record(templateSchema) ?? ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA;
  const properties = record(schema.properties) ?? {};

  const section = propertyOf(schema, schema, 'sections');
  const sectionItem = deref(schema, section?.items);
  const paragraphs = propertyOf(schema, sectionItem, 'paragraphs');
  const figure = propertyOf(schema, sectionItem, 'figure');
  const pullQuotes = propertyOf(schema, schema, 'pullQuotes');
  const pullQuoteItem = deref(schema, pullQuotes?.items);
  const sources = propertyOf(schema, schema, 'sources');
  const sourceItem = deref(schema, sources?.items);

  const assetIdPatternSource = text(record(record(schema.$defs)?.assetId)?.pattern);
  let assetIdPattern = /^[a-zA-Z0-9._-]{1,128}$/;
  if (assetIdPatternSource) {
    try {
      assetIdPattern = new RegExp(assetIdPatternSource);
    } catch {
      // A schema whose pattern will not compile keeps the pdf-tool default —
      // the id grammar job-assets.ts actually binds. Never fall through to
      // "no check at all": that is how a slashed blobKey reached a data slot.
    }
  }

  return {
    slots: new Set(Object.keys(properties)),
    assetIdPattern,
    maxTitle: maxLengthOf(schema, properties.title),
    maxDeck: maxLengthOf(schema, properties.deck),
    maxKicker: maxLengthOf(schema, properties.kicker),
    maxAuthor: maxLengthOf(schema, properties.author),
    maxDate: maxLengthOf(schema, properties.date),
    maxSections: positiveInt(section?.maxItems),
    maxHeading: maxLengthOf(schema, record(sectionItem?.properties)?.heading),
    maxParagraphs: positiveInt(paragraphs?.maxItems),
    maxParagraph: maxLengthOf(schema, paragraphs?.items),
    maxCaption: maxLengthOf(schema, record(figure?.properties)?.caption),
    maxPullQuotes: positiveInt(pullQuotes?.maxItems),
    maxQuote: maxLengthOf(schema, record(pullQuoteItem?.properties)?.quote),
    maxAttribution: maxLengthOf(schema, record(pullQuoteItem?.properties)?.attribution),
    maxSources: positiveInt(sources?.maxItems),
    maxSourceLabel: maxLengthOf(schema, record(sourceItem?.properties)?.label),
    maxSourceUrl: maxLengthOf(schema, record(sourceItem?.properties)?.url),
    maxSourceNote: maxLengthOf(schema, record(sourceItem?.properties)?.note),
  };
};

// ── image conversion ─────────────────────────────────────────────────────────

/**
 * The public artifact path an article image always carries. Deliberately the
 * same shape artifact-trust.ts's PUBLIC_ARTIFACT_PATH_RE accepts (the /img
 * half of it): `/img/<requestId>/<sha256>.<ext>`. Anything else — a remote
 * URL, a hand-written `/img/logo.png`, a raw `image/…` blob key — is NOT
 * convertible, because there is no honest blobKey to derive from it.
 */
const PUBLIC_IMG_PATH_RE = /^\/img\/([^/]+)\/([0-9a-f]{64}\.[a-z]+)$/i;

/** `/img/<requestId>/<sha>.<ext>` → the artifact store key. undefined if not one. */
export const artifactBlobKeyForImageSrc = (src: string): string | undefined => {
  const match = PUBLIC_IMG_PATH_RE.exec(src.trim());
  if (!match) return undefined;
  return `image/${match[1]}/${match[2]}`;
};

/**
 * The asset-id allocator.
 *
 * An assetId is the name a data slot uses and the last path segment of
 * `https://render.assets.invalid/<assetId>` — so it must satisfy pdf-tool's
 * own grammar (`^[a-zA-Z0-9._-]{1,128}$`: NO SLASHES, which is exactly why a
 * blobKey can never be one). Ids here are derived from the SLOT, not from the
 * blob: `cover` for the hero, `figure-<nodeId>` for a node's figure. That is
 * deterministic (same article in, same ids out), stable across edits that
 * reorder nodes, human-legible in a warning ("figure-n_m8f2r6" points at one
 * node), and — unlike a sha-derived id — carries no blob sha into text an
 * agent or an editor reads. The same blobKey referenced twice gets one id and
 * one `assets.images[]` entry.
 */
class AssetAllocator {
  private readonly byBlobKey = new Map<string, string>();
  private readonly used = new Set<string>();
  readonly images: RenderDataAssetImage[] = [];

  constructor(private readonly pattern: RegExp) {}

  /** A legible, unique, grammar-valid id derived from `hint`. */
  private mint(hint: string): string {
    const base = hint.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || 'asset';
    let candidate = base;
    let n = 2;
    while (this.used.has(candidate)) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    this.used.add(candidate);
    return candidate;
  }

  /**
   * Register `blobKey` under a slot-derived id, reusing the id already
   * allocated for it. Returns undefined only when the minted id would not
   * satisfy the target schema's own assetId grammar — never a value the
   * render service could not fetch.
   */
  add(blobKey: string, hint: string): string | undefined {
    const existing = this.byBlobKey.get(blobKey);
    if (existing) return existing;
    const assetId = this.mint(hint);
    if (!this.pattern.test(assetId)) return undefined;
    this.byBlobKey.set(blobKey, assetId);
    this.images.push({ assetId, blobKey });
    return assetId;
  }
}

// ── body → paragraphs ────────────────────────────────────────────────────────
//
// `public.body` is EITHER a flat string (plain text; blank lines split
// paragraphs — content-item-v1.ts says so, and render-nodes.ts renders it
// that way) OR a rich_text.v1 document. Both are handled; both end as the
// same stream of blocks.

type Block =
  | { t: 'heading'; text: string }
  | { t: 'paragraph'; text: string }
  | { t: 'quote'; text: string }
  | { t: 'figure'; blobKey: string; caption?: string; nodeId: string };

const plainTextParagraphs = (value: string): string[] =>
  value
    .split(/\n{2,}/)
    .map(collapseWhitespace)
    .filter((paragraph) => paragraph.length > 0);

type RichNode = { nodeType: string; value?: unknown; content?: unknown; data?: unknown };

const richNodes = (value: unknown): RichNode[] =>
  Array.isArray(value)
    ? (value.filter((entry) => isRecord(entry) && typeof entry.nodeType === 'string') as RichNode[])
    : [];

/**
 * The flat text of a rich-text node. Marks are dropped (the template's slots
 * are plain strings) and a hyperlink flattens to its own text — its href has
 * nowhere to go in this contract, which the caller is told about once per
 * node rather than once per link.
 */
const flattenInline = (nodes: RichNode[], onLink: () => void): string => {
  let out = '';
  for (const node of nodes) {
    if (node.nodeType === 'text') {
      out += typeof node.value === 'string' ? node.value : '';
      continue;
    }
    if (node.nodeType === INLINES.HYPERLINK) onLink();
    out += flattenInline(richNodes(node.content), onLink);
  }
  return out;
};

const listItemParagraphs = (list: RichNode, onLink: () => void): string[] => {
  const ordered = list.nodeType === BLOCKS.OL_LIST;
  const out: string[] = [];
  richNodes(list.content).forEach((item, index) => {
    // A list item holds blocks (paragraphs, or a nested list). Flattened to
    // one line per item: the template slots plain paragraph strings and has
    // no list of its own, so the marker is the only thing that keeps an
    // enumeration readable as one. Furniture, not invented content.
    const inner = richNodes(item.content)
      .map((block) =>
        block.nodeType === BLOCKS.UL_LIST || block.nodeType === BLOCKS.OL_LIST
          ? listItemParagraphs(block, onLink).join(' ')
          : flattenInline(richNodes(block.content), onLink)
      )
      .map(collapseWhitespace)
      .filter((part) => part.length > 0)
      .join(' ');
    if (inner.length === 0) return;
    out.push(ordered ? `${index + 1}. ${inner}` : `• ${inner}`);
  });
  return out;
};

/**
 * Flatten one rich_text.v1 document to blocks.
 *
 * HEADINGS START A NEW SECTION rather than becoming a paragraph. Two reasons.
 * (1) The live renderer already treats an in-body heading as the section
 * heading: render-nodes.ts suppresses a node's own `public.title` when its
 * body opens with a heading-2, precisely so the page does not show the
 * heading twice — a PDF that folded that heading into prose would say
 * something different from the page it is a PDF of. (2) A heading rendered
 * as a paragraph is silently demoted to a sentence, and nothing in the
 * reader's hands says a heading was ever there; a heading rendered as a
 * heading is exactly what it was. H3 flattens to the same level as H2: the
 * section shape is `{heading, paragraphs}` with no sub-heading slot, so one
 * level of hierarchy is lost either way, and losing it VISIBLY beats losing
 * it silently.
 */
const richTextBlocks = (doc: Record<string, unknown>, nodeId: string, report: (entry: string) => void): Block[] => {
  const blocks: Block[] = [];
  let reportedLink = false;
  const onLink = () => {
    if (reportedLink) return;
    reportedLink = true;
    report(`dropped_link:${nodeId}`);
  };
  const push = (t: 'heading' | 'paragraph' | 'quote', raw: string) => {
    const value = collapseWhitespace(raw);
    if (value.length > 0) blocks.push({ t, text: value });
  };

  for (const node of richNodes(doc.content)) {
    switch (node.nodeType) {
      case BLOCKS.PARAGRAPH:
        push('paragraph', flattenInline(richNodes(node.content), onLink));
        break;
      case BLOCKS.HEADING_2:
      case BLOCKS.HEADING_3:
        push('heading', flattenInline(richNodes(node.content), onLink));
        break;
      case BLOCKS.UL_LIST:
      case BLOCKS.OL_LIST:
        for (const paragraph of listItemParagraphs(node, onLink)) push('paragraph', paragraph);
        break;
      case BLOCKS.QUOTE:
        // The article's OWN marking of a quotation — the only thing this
        // module ever treats as a pull quote. See buildRenderData's
        // pullQuotes note.
        push('quote', flattenInline(richNodes(node.content), onLink));
        break;
      case BLOCKS.EMBEDDED_ENTRY:
      case BLOCKS.EMBEDDED_ASSET:
        // Resolving an embed needs the store; this module has none and will
        // not guess at one. Reported, never rendered as a hole.
        report(`unresolved_embed:${nodeId}`);
        break;
      default:
        break;
    }
  }
  return blocks;
};

/** Split a paragraph that is over the schema's cap, at sentence then word boundaries. */
const splitLongParagraph = (paragraph: string, max: number | undefined): string[] => {
  if (!max || paragraph.length <= max) return [paragraph];
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    const space = window.lastIndexOf(' ');
    let cut = max;
    if (sentence > max * 0.4) cut = sentence + 1;
    else if (space > 0) cut = space;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out.filter((part) => part.length > 0);
};

// ── the mapping ──────────────────────────────────────────────────────────────

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * The article's own date, formatted for a cover byline.
 *
 * Deliberately hand-formatted from the ISO parts rather than through
 * `toLocaleDateString`: locale formatting depends on the ICU data the host
 * happens to ship, and this module's contract is that the same article maps
 * to the same bytes everywhere. A value that is not an ISO instant is passed
 * through verbatim — better the article's own string than a wrong guess.
 */
export const formatRenderDate = (value: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return value.trim();
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return value.trim();
  return `${Number(match[3])} ${month} ${match[1]}`;
};

type ArticleImage = { src?: string; caption?: string; alt?: string; type?: string };

const mediaOf = (value: unknown): ArticleImage | undefined => {
  const media = record(value);
  if (!media) return undefined;
  return {
    src: text(media.src),
    caption: text(media.caption),
    alt: text(media.alt),
    type: text(media.type),
  };
};

type WorkingSection = {
  heading?: string;
  paragraphs: string[];
  figure?: { assetId: string; caption?: string };
  nodeIds: string[];
};

/**
 * Map one content_item to schema-valid render `data` plus the job assets its
 * images need, and report everything it could not fill.
 *
 * `contentItem` is the OBJECT RECORD, not just the body: the article's date
 * is not a body field at all — it lives on the record envelope
 * (`publication.published_time`, else `updated_at`, object-record-v1.ts), so
 * a body-only signature could never fill `date` honestly. A bare body is
 * accepted too (anything carrying `nodes`), it simply reports `missing:date`.
 * Input is `unknown` and read defensively throughout: this runs on
 * agent-authored records, and a mapper that throws on an unexpected shape
 * fails the render it exists to make succeed.
 */
export const buildRenderData = (contentItem: unknown, opts: BuildRenderDataOptions = {}): BuildRenderDataResult => {
  const limits = readRenderDataLimits(opts.templateSchema);
  const unfilled: string[] = [];
  const seen = new Set<string>();
  const report = (entry: string) => {
    if (seen.has(entry)) return;
    seen.add(entry);
    unfilled.push(entry);
  };

  const outer = record(contentItem) ?? {};
  const body = record(outer.body) ?? (Array.isArray(outer.nodes) ? outer : {});
  const assets = new AssetAllocator(limits.assetIdPattern);

  /** Cut a string to the target schema's maxLength, reporting when it bites. */
  const fit = (value: string, max: number | undefined, slot: string): string => {
    if (!max || value.length <= max) return value;
    report(`truncated:${slot}`);
    const window = value.slice(0, max - 1);
    const space = window.lastIndexOf(' ');
    return `${(space > max * 0.5 ? window.slice(0, space) : window).trimEnd()}…`;
  };

  /**
   * Convert one image src to a job asset and return the bare assetId. An src
   * that is not a convertible artifact path yields undefined and a report —
   * the caller then omits the slot rather than emitting a value the render
   * service cannot fetch (W1 `ASSET_MISSING` fails the WHOLE render on one).
   */
  const assetIdFor = (src: string | undefined, slot: string, hint: string): string | undefined => {
    if (!src) return undefined;
    const blobKey = artifactBlobKeyForImageSrc(src);
    if (!blobKey) {
      report(`unconvertible_image:${slot}`);
      return undefined;
    }
    const assetId = assets.add(blobKey, hint);
    if (!assetId) report(`unconvertible_image:${slot}`);
    return assetId;
  };

  // ── envelope ───────────────────────────────────────────────────────────────

  const title = text(body.title);
  const deck = text(body.deck) ?? text(body.description);
  const author = text(body.author);
  // `kicker` from the article's own taxonomy — its editorial category. NOT
  // from the artifact kind: see the note under BuildRenderDataOptions.
  const taxonomy = record(body.taxonomy);
  const kicker = text(taxonomy?.category);
  // The date the object actually carries: the publication stamp, else the
  // record's own last-updated. Neither is a body field, and there is no
  // `date` on content_item.v1 to read.
  const publication = record(outer.publication);
  const dateSource = text(publication?.published_time) ?? text(outer.updated_at);

  // The hero: content_item.v1's `image` ({src, alt}) is how an article
  // designates one — "Hero image, rendered exactly once by the article
  // furniture". There is no separate hero/featured field, and `seo` carries
  // no ogImage on this type.
  const hero = mediaOf(body.image);
  // Allocated here, before the body's figures, so the cover is the first
  // entry in `assets.images[]` — the order the render reads it in.
  let coverImage: string | undefined;
  if (hero?.src) coverImage = assetIdFor(hero.src, 'coverImage', 'cover');
  else report('missing:coverImage');

  // ── nodes → blocks ─────────────────────────────────────────────────────────

  const blocks: Block[] = [];
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];

  for (const raw of nodes) {
    const node = record(raw);
    if (!node) continue;
    const nodeId = text(node.id) ?? 'unknown';
    const kind = text(node.kind) ?? 'content';
    const visibility = text(node.visibility) ?? 'public';

    if (visibility !== 'public') {
      report(`skipped_node:non_public:${nodeId}`);
      continue;
    }
    // Only `content` nodes are article prose. `action` is a call to action,
    // `placement` is an ad slot or an offer card, `interactive` is a chat
    // invitation: all three are behaviors of a live page, none of them is
    // reader prose, and the template has no slot for any of them — a CTA
    // flattened into a paragraph would print a dead "Book a consultation"
    // with its link stripped, and a `placement` is the commercial layer,
    // which has no business in a reader-facing document at all. Skipped
    // loudly so nobody wonders where the CTA went.
    if (kind !== 'content') {
      report(`skipped_node:${kind}:${nodeId}`);
      continue;
    }

    const pub = record(node.public) ?? {};
    const nodeBody = pub.body;
    const bodyBlocks = isRecord(nodeBody)
      ? richTextBlocks(nodeBody, nodeId, report)
      : typeof nodeBody === 'string'
        ? plainTextParagraphs(nodeBody).map((paragraph): Block => ({ t: 'paragraph', text: paragraph }))
        : [];

    // render-nodes.ts's rule, kept verbatim so the PDF and the page agree: a
    // body that OPENS with a heading already carries the section heading, and
    // emitting `public.title` above it renders the heading twice.
    const nodeTitle = text(pub.title);
    if (nodeTitle && bodyBlocks[0]?.t !== 'heading') blocks.push({ t: 'heading', text: nodeTitle });
    blocks.push(...bodyBlocks);

    // `public.items` is the node's own list block.
    const items = Array.isArray(pub.items) ? pub.items : [];
    for (const item of items) {
      const value = text(item);
      if (value) blocks.push({ t: 'paragraph', text: `• ${collapseWhitespace(value)}` });
    }

    // The figure: `public.media` when it is an IMAGE (a `document` is a
    // download block on the page, never a figure — media-type.ts draws
    // exactly that line), else the first entry of `public.images[]`.
    const media = mediaOf(pub.media);
    const gallery = Array.isArray(pub.images)
      ? pub.images.map(mediaOf).filter((entry): entry is ArticleImage => entry !== undefined)
      : [];
    if (media && media.type !== 'image') report(`skipped_media:${media.type ?? 'unknown'}:${nodeId}`);
    const figureSource = media?.type === 'image' ? media : gallery[0];
    if (figureSource?.src) {
      const blobKey = artifactBlobKeyForImageSrc(figureSource.src);
      if (blobKey) {
        blocks.push({
          t: 'figure',
          blobKey,
          ...(figureSource.caption ? { caption: figureSource.caption } : {}),
          nodeId,
        });
      } else {
        report(`unconvertible_image:sections.figure:${nodeId}`);
      }
    }
    if (gallery.length > (media?.type === 'image' ? 0 : 1)) report(`dropped_figure:${nodeId}`);
  }

  // ── blocks → sections ──────────────────────────────────────────────────────
  //
  // A heading opens a section; paragraphs fill the open one; a figure attaches
  // to the open one. That single rule is what keeps the article's own shape:
  // a media-only node (no title, no body — the drlurie article has two)
  // attaches its figure to the section it visually follows instead of being
  // dropped, and an untitled prose node continues the section it follows
  // instead of needing a heading nobody wrote.

  const working: WorkingSection[] = [];
  const pullQuotes: RenderDataPullQuote[] = [];
  let current: WorkingSection | undefined;

  for (const block of blocks) {
    if (block.t === 'heading') {
      current = { heading: block.text, paragraphs: [], nodeIds: [] };
      working.push(current);
      continue;
    }
    if (block.t === 'quote') {
      // Lifted, not repeated: the template renders pull quotes as their own
      // block, so leaving the quote in the prose too would print it twice.
      pullQuotes.push({ quote: block.text });
      continue;
    }
    if (!current) {
      current = { paragraphs: [], nodeIds: [] };
      working.push(current);
    }
    if (block.t === 'paragraph') {
      current.paragraphs.push(block.text);
      continue;
    }
    // figure
    if (!current.nodeIds.includes(block.nodeId)) current.nodeIds.push(block.nodeId);
    if (current.figure) {
      report(`dropped_figure:${block.nodeId}`);
      continue;
    }
    const assetId = assets.add(block.blobKey, `figure-${block.nodeId}`);
    if (!assetId) {
      report(`unconvertible_image:sections.figure:${block.nodeId}`);
      continue;
    }
    current.figure = {
      assetId,
      ...(block.caption ? { caption: fit(block.caption, limits.maxCaption, `caption:${block.nodeId}`) } : {}),
    };
  }

  // Close out: a section with no paragraphs cannot be emitted (the contract
  // requires at least one), so hand its figure back to the section it follows
  // rather than losing the image with the empty heading.
  const closed: WorkingSection[] = [];
  for (const section of working) {
    if (section.paragraphs.length > 0) {
      closed.push(section);
      continue;
    }
    const previous = closed[closed.length - 1];
    if (section.figure && previous && !previous.figure) previous.figure = section.figure;
    else if (section.figure) for (const nodeId of section.nodeIds) report(`dropped_figure:${nodeId}`);
    for (const nodeId of section.nodeIds) report(`empty_section:${nodeId}`);
  }

  // A leading run with no heading of its own — the lede, which the drlurie
  // article opens with — is headed by the article's own title. That is the
  // article's own words, not invented copy, and it is what a printed article
  // does: the title again at the top of the body.
  const headed: WorkingSection[] = closed.map((section, index) => {
    if (section.heading) return section;
    if (index === 0 && title) return { ...section, heading: title };
    return section;
  });
  // Any remaining headless section merges back into the one before it.
  const merged: WorkingSection[] = [];
  for (const section of headed) {
    const previous = merged[merged.length - 1];
    if (!section.heading && previous) {
      previous.paragraphs.push(...section.paragraphs);
      if (!previous.figure && section.figure) previous.figure = section.figure;
      continue;
    }
    merged.push(section);
  }

  // Paragraph limits: split an over-long paragraph rather than cutting it,
  // then spill a section with too many paragraphs into a continuation section
  // under the same heading. Both are lossless; neither invents a word.
  const sections: RenderDataSection[] = [];
  for (const section of merged) {
    const heading = fit(section.heading ?? title ?? '', limits.maxHeading, 'sections.heading');
    if (heading.length === 0) {
      for (const nodeId of section.nodeIds) report(`empty_section:${nodeId}`);
      continue;
    }
    const paragraphs = section.paragraphs.flatMap((paragraph) => splitLongParagraph(paragraph, limits.maxParagraph));
    const perSection = limits.maxParagraphs ?? paragraphs.length;
    for (let index = 0; index < paragraphs.length; index += perSection) {
      const chunk = paragraphs.slice(index, index + perSection);
      sections.push({
        heading,
        paragraphs: chunk,
        // The figure rides with the LAST chunk, matching the page, where
        // media renders after the node's prose.
        ...(section.figure && index + perSection >= paragraphs.length ? { figure: section.figure } : {}),
      });
    }
  }

  if (limits.maxSections !== undefined && sections.length > limits.maxSections) {
    for (let index = limits.maxSections; index < sections.length; index += 1) report(`dropped_section:${index}`);
    sections.length = limits.maxSections;
  }
  if (sections.length === 0) report('missing:sections');

  // ── sources ────────────────────────────────────────────────────────────────

  const rawSourceList = record(body.sources)?.source_list;
  const sourceList = Array.isArray(rawSourceList) ? rawSourceList : [];
  const sources: RenderDataSource[] = [];
  sourceList.forEach((raw, index) => {
    const entry = record(raw);
    const label = text(entry?.name);
    if (!label) return;
    if (limits.maxSources !== undefined && sources.length >= limits.maxSources) {
      report(`dropped_source:${index}`);
      return;
    }
    const url = text(entry?.url);
    // `note` is the publisher, verbatim. `accessed_at` is left out on
    // purpose: turning a date into "Accessed 3 September 2026" would be this
    // module writing prose, which it does not do.
    const note = text(entry?.publisher);
    sources.push({
      label: fit(label, limits.maxSourceLabel, `sources.label`),
      ...(url && (limits.maxSourceUrl === undefined || url.length <= limits.maxSourceUrl) ? { url } : {}),
      ...(note ? { note: fit(note, limits.maxSourceNote, 'sources.note') } : {}),
    });
  });
  if (sources.length === 0) report('missing:sources');

  // ── pull quotes ────────────────────────────────────────────────────────────
  //
  // ONLY what the article itself marked as a quotation (a rich_text.v1
  // blockquote). No sentence is ever promoted to a pull quote because it
  // sounded quotable — that would be this module writing the article. An
  // empty array is honest and the contract allows it.
  const quotes: RenderDataPullQuote[] = [];
  pullQuotes.forEach((quote, index) => {
    if (limits.maxPullQuotes !== undefined && quotes.length >= limits.maxPullQuotes) {
      report(`dropped_pull_quote:${index}`);
      return;
    }
    quotes.push({ quote: fit(quote.quote, limits.maxQuote, 'pullQuotes.quote') });
  });
  if (quotes.length === 0) report('missing:pullQuotes');

  // ── assemble ───────────────────────────────────────────────────────────────

  if (!title) report('missing:title');
  if (!deck) report('missing:deck');
  if (!author) report('missing:author');
  if (!kicker) report('missing:kicker');
  if (!dateSource) report('missing:date');
  // `brand` is pdf-render-brand.ts's to build and the bridge's to inject
  // (D-3). Reported so a caller reading this output alone knows the slot is
  // still owned by someone else, never filled here.
  if (opts.brand === undefined) report('missing:brand');

  const data: RenderData = { sections, pullQuotes: quotes, sources };
  // These three are the contract's own required arrays. A target schema that
  // does not declare one is a template this mapper cannot honestly fill, so
  // the slot is dropped and named rather than emitted into an
  // `additionalProperties: false` schema that will reject the whole render.
  for (const slot of ['sections', 'pullQuotes', 'sources'] as const) {
    if (limits.slots.has(slot)) continue;
    report(`unsupported_slot:${slot}`);
    delete (data as Record<string, unknown>)[slot];
  }
  const put = <K extends keyof RenderData>(slot: K, value: RenderData[K] | undefined): void => {
    if (value === undefined) return;
    if (!limits.slots.has(slot)) {
      report(`unsupported_slot:${slot}`);
      return;
    }
    data[slot] = value;
  };
  put('brand', opts.brand);
  put('title', title ? fit(title, limits.maxTitle, 'title') : undefined);
  put('deck', deck ? fit(deck, limits.maxDeck, 'deck') : undefined);
  put('kicker', kicker ? fit(kicker, limits.maxKicker, 'kicker') : undefined);
  put('author', author ? fit(author, limits.maxAuthor, 'author') : undefined);
  put('date', dateSource ? fit(formatRenderDate(dateSource), limits.maxDate, 'date') : undefined);
  put('coverImage', coverImage);

  // Only assets the emitted `data` actually names travel with the job. A
  // figure can be allocated and then not survive — its section came out empty,
  // or fell past the section cap — and shipping bytes for an image the PDF
  // never shows is at best waste and at worst a picture nobody asked for.
  // `assets.images[]` and the ids inside `data` are the same set, always.
  const referenced = new Set<string>(
    [data.coverImage, ...sections.map((section) => section.figure?.assetId)].filter(
      (id): id is string => typeof id === 'string'
    )
  );
  const images = assets.images.filter((image) => referenced.has(image.assetId));

  return { data, assets: { images }, unfilled };
};
