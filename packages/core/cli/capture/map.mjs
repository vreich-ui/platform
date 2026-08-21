#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { writeJson } from './snapshot-v1.mjs';

export const CAPTURE_MAP_SCHEMA_VERSION = 'capture-map.v1';
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.72;

// EVERY type `buildForType` below can actually build — and nothing else. This set is what gates a
// block_classifier suggestion, so a name that is not here is rejected as unregistered. It used to
// list seven text types while the platform shipped 24, which is why the one node meant to rescue a
// declined block could only ever offer it the same handful of shapes the heuristic had already
// tried. T12.23 adds the seven structured types; keep this list and the switch in lockstep — the
// focused mapper test asserts they match, so a builder without a vocabulary entry (or the reverse)
// fails closed rather than silently never being suggested.
export const SUPPORTED_SECTION_TYPES = new Set([
  'hero',
  'lede',
  'prose',
  'bio',
  'contact_form',
  'cta_banner',
  'link_list',
  'faq',
  'comparison_table',
  'testimonial',
  'stats',
  'timeline',
  'steps',
  'checklist',
]);
// Keep this capture-side guard aligned with the governed PageType registry.
// The focused mapper test compares it to the live definition so registry drift
// fails closed before a capture artifact can be emitted.
export const CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS = {
  home: new Set(['hero', 'checklist', 'content_grid', 'bio', 'newsletter_signup', 'shared_ref']),
  standard: 'any',
};

// ─── T12.14 asset-aware mapping ──────────────────────────────────────────────
//
// Media blocks used to be DECLINED outright: the mapper had no way to put an
// image into a section, so a gallery became a gap and every emitted clone came
// out text-only. The section types it needs already exist (`media`,
// `content_split`, `brand_row`, `bio`); what was missing is the two-phase
// binding below.
//
// PHASE 1 (here, deterministic, offline): a media-shaped block becomes a real
// candidate whose section data is complete EXCEPT for its asset field, plus an
// `assetPlan` naming the field and carrying, per item, the source asset's
// manifest identity and its OWN alt text. The plan deliberately carries NO
// source URL — a hotlink is unreachable from the binder by construction.
//
// PHASE 2 (emit.mjs, online): the emitter materializes each planned asset as a
// first-party artifact and calls `bindSectionAssets`, which accepts ONLY a
// Major-Key artifact reference and derives the served first-party path itself.
// An asset that is not materialized cannot be bound, so the section is dropped
// and the gap stays recorded. Never a hotlink, never a coerced field.
export const CONTENT_SPLIT_MAX_IMAGES = 2;
export const MEDIA_MAX_ITEMS = 8;
export const BRAND_ROW_MIN_LOGOS = 2;
export const BRAND_ROW_MAX_LOGOS = 8;
/** `capturePolicy.rights.media` value that permits retaining source media. */
export const MEDIA_RETENTION_RIGHT = 'retain_referenced_allowed_origin_media';
/** A body shorter than this is a label, not copy a section has to preserve. */
export const SUBSTANTIVE_BODY_MIN_CHARS = 40;

/**
 * A Major Key artifact reference, mirrored EXACTLY from the engine's
 * `MAJOR_KEY_ARTIFACT_REF_RE` (packages/core/server/lib/artifact-trust.ts) so
 * that anything this mapper produces is something `validateObject` accepts, and
 * nothing wider.
 */
export const MAJOR_KEY_ARTIFACT_REF_RE = /^(image|pdf)\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i;
/** The ONLY shape an emitted asset field may carry: the served first-party path. */
export const FIRST_PARTY_ASSET_PATH_RE = /^\/(img|pdf)\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i;

/**
 * The served first-party path for a materialized artifact — the inverse of the
 * `/img/*` and `/pdf/*` redirects (artifact-trust.ts `publicPathForArtifactRef`).
 *
 * THIS IS THE HOTLINK GUARD. The only input it accepts is a Major-Key artifact
 * reference; a source-origin URL, a third-party URL, a `data:` URI, a repo path
 * and a bare filename all fail `MAJOR_KEY_ARTIFACT_REF_RE` and return null. The
 * binder below has no other way to obtain a value for an asset field, so an
 * un-materialized asset can only ever quarantine.
 */
export function firstPartyAssetPath(artifactRef) {
  if (typeof artifactRef !== 'string' || !MAJOR_KEY_ARTIFACT_REF_RE.test(artifactRef)) return null;
  const path = artifactRef.startsWith('pdf/')
    ? `/pdf/${artifactRef.slice('pdf/'.length)}`
    : `/img/${artifactRef.slice('image/'.length)}`;
  return FIRST_PARTY_ASSET_PATH_RE.test(path) ? path : null;
}

/** Per-field cardinality, mirrored from the live section schemas. */
export const ASSET_FIELD_BOUNDS = {
  items: { min: 1, max: MEDIA_MAX_ITEMS },
  images: { min: 1, max: CONTENT_SPLIT_MAX_IMAGES },
  logos: { min: BRAND_ROW_MIN_LOGOS, max: BRAND_ROW_MAX_LOGOS },
  portrait: { min: 1, max: 1 },
};

/**
 * Bind one planned asset field onto its section.
 *
 * `resolveArtifactRef(manifestRef)` returns the MATERIALIZED artifact's Major-Key
 * reference, or null/undefined when it was never materialized. Everything else
 * is derived here: the served path, the schema's cardinality, and the alt text
 * (which comes from the source block's own item-level text association and is
 * REQUIRED — an image with no accessible name is not bindable).
 *
 * Returns `{ section, bound, overflow }` or `{ error }`. It never returns a
 * partially-bound section below the field's minimum: that is a quarantine.
 */
export function bindSectionAssets(section, assetPlan, resolveArtifactRef) {
  if (!assetPlan) return { section, bound: [], overflow: [] };
  const bounds = ASSET_FIELD_BOUNDS[assetPlan.target];
  if (!bounds) return { error: { code: 'unknown_asset_field', detail: String(assetPlan.target) } };
  const entries = Array.isArray(assetPlan.entries) ? assetPlan.entries : [];
  const resolved = [];
  const unresolved = [];
  for (const entry of entries) {
    const artifactRef = typeof resolveArtifactRef === 'function' ? resolveArtifactRef(entry.manifestRef) : null;
    const src = firstPartyAssetPath(artifactRef);
    const alt = clean(entry.alt);
    if (!src || !alt) {
      unresolved.push({ manifestRef: entry.manifestRef, reason: src ? 'missing_alt_text' : 'artifact_not_materialized' });
      continue;
    }
    resolved.push({ manifestRef: entry.manifestRef, artifactRef, src, alt });
  }
  if (resolved.length < bounds.min) {
    return {
      error: {
        code: 'asset_binding_unresolved',
        detail:
          `${resolved.length}/${entries.length} planned asset(s) resolved to a first-party artifact path; ` +
          `${assetPlan.target} requires at least ${bounds.min}`,
        unresolved,
      },
    };
  }
  const used = resolved.slice(0, bounds.max);
  const data = { ...section.data };
  if (assetPlan.target === 'items') {
    data.items = used.map(({ src, alt }) => ({ kind: 'image', src, alt }));
  } else if (assetPlan.target === 'images') {
    data.images = used.map(({ src, alt }) => ({ src, alt }));
  } else if (assetPlan.target === 'logos') {
    data.logos = used.map(({ src, alt }) => ({ src, alt }));
  } else {
    // `bio` offers BOTH idioms: the trusted raw reference (validated against the
    // artifact index, unrendered) and the rendered {src, alt} pair. Bind both —
    // the *AssetRef is the durable artifact identity, the path is what renders.
    data.portraitAssetRef = used[0].artifactRef;
    data.portrait = { src: used[0].src, alt: used[0].alt };
  }
  return {
    section: { ...section, data },
    bound: used,
    overflow: resolved.slice(bounds.max),
    ...(unresolved.length > 0 ? { unresolved } : {}),
  };
}

/**
 * Bind every pending asset section in a mapping, in place on a clone.
 * Shared by the emitter and by the focused tests, so "what the emitter creates"
 * and "what the tests prove schema-valid" cannot diverge.
 */
export function bindMappingAssets(mapping, resolveArtifactRef) {
  const result = JSON.parse(JSON.stringify(mapping));
  const bound = [];
  const quarantined = [];
  for (const page of result.pages ?? []) {
    const sectionsById = new Map((page.pageBody?.sections ?? []).map((section) => [section.id, section]));
    for (const candidate of page.candidates ?? []) {
      if (!candidate.assetPlan) continue;
      const outcome = bindSectionAssets(candidate.section, candidate.assetPlan, resolveArtifactRef);
      const record = {
        pageRef: page.pageRef,
        candidateId: candidate.candidateId,
        sectionId: candidate.section.id,
        sectionType: candidate.sectionType,
        target: candidate.assetPlan.target,
      };
      if (outcome.error) {
        quarantined.push({ ...record, ...outcome.error });
        page.pageBody.sections = (page.pageBody.sections ?? []).filter(
          (section) => section.id !== candidate.section.id
        );
        candidate.assetBindingStatus = 'quarantined';
        continue;
      }
      candidate.section = outcome.section;
      candidate.data = outcome.section.data;
      candidate.assetBindingStatus = 'bound';
      const emitted = sectionsById.get(candidate.section.id);
      if (emitted) Object.assign(emitted, outcome.section);
      bound.push({
        ...record,
        manifestRefs: outcome.bound.map((item) => item.manifestRef),
        ...(outcome.overflow.length > 0 ? { overflowManifestRefs: outcome.overflow.map((i) => i.manifestRef) } : {}),
      });
    }
  }
  return { mapping: result, bound, quarantined };
}

const hash = (value, length = 12) => createHash('sha256').update(value).digest('hex').slice(0, length);
const clean = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const escapeHtml = (value) =>
  clean(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const richText = (value) => `<p>${escapeHtml(value)}</p>`;

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage: node packages/core/cli/capture/map.mjs --snapshot <snapshot.v1.json> --out <mapping.v1.json> [--assistance <suggestions.json>] [--threshold <0..1>]'
  );
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') usage();
    if (!key.startsWith('--')) usage(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ['snapshot', 'out']) if (!args[required]) usage(`Missing --${required}`);
  return args;
}

const viewportArea = (block) => {
  const boxes = Object.values(block.boundingBoxes ?? {});
  if (boxes.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...boxes.map((box) => Number(box.width ?? 0) * Number(box.height ?? 0)));
};

const blockSignature = (block) =>
  JSON.stringify({
    text: clean(block.text?.value),
    links: (block.links ?? []).map((link) => [clean(link.label), link.href]).sort(),
    assets: [...(block.assetUrls ?? [])].sort(),
  });

function reconcileBlocks(page) {
  const account = new Map();
  const bySignature = new Map();
  for (const block of page.blocks) {
    const signature = blockSignature(block);
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), block]);
  }

  const unique = [];
  for (const group of bySignature.values()) {
    const ordered = [...group].sort(
      (left, right) => viewportArea(left) - viewportArea(right) || left.ordinal - right.ordinal
    );
    const keeper = ordered[0];
    unique.push(keeper);
    for (const duplicate of ordered.slice(1)) {
      account.set(duplicate.id, { blockRef: duplicate.id, status: 'duplicate', resolvedInto: keeper.id });
    }
  }

  const survivors = [];
  for (const block of unique.sort((left, right) => left.ordinal - right.ordinal)) {
    const text = clean(block.text?.value);
    const contained = unique.filter(
      (other) =>
        other.id !== block.id && clean(other.text?.value).length >= 20 && text.includes(clean(other.text?.value))
    );
    if (contained.length >= 2) {
      account.set(block.id, {
        blockRef: block.id,
        status: 'ignored_noncontent',
        reason: 'aggregate_page_wrapper',
      });
      continue;
    }
    survivors.push(block);
  }

  // A builder may expose the same semantic region as an outer section plus
  // one near-identical inner div. Keep the richer outer block and account for
  // the inner one explicitly rather than mapping the copy twice.
  const final = [];
  for (const block of survivors) {
    const text = clean(block.text?.value);
    const outer = survivors.find((candidate) => {
      if (candidate.id === block.id || candidate.ordinal > block.ordinal) return false;
      const candidateText = clean(candidate.text?.value);
      return (
        candidateText.length > text.length && candidateText.length <= text.length * 1.4 && candidateText.includes(text)
      );
    });
    if (outer) {
      account.set(block.id, { blockRef: block.id, status: 'merged', resolvedInto: outer.id });
      continue;
    }
    final.push(block);
  }

  return { blocks: final, account };
}

function blockHeadings(page, block) {
  const text = clean(block.text?.value);
  return (page.outline ?? [])
    .filter((node) => Number.isInteger(node.level) && clean(node.text) && text.includes(clean(node.text)))
    .map((node) => ({ text: clean(node.text), level: node.level }));
}

function linkTarget(href, origin) {
  const url = new URL(href);
  if (url.origin === origin) return { kind: 'route', href: `${url.pathname}${url.search}${url.hash}` || '/' };
  return { kind: 'external', href: url.href };
}

function linkActions(block, origin) {
  const seen = new Set();
  return (block.links ?? []).flatMap((link, index) => {
    const label = clean(link.label);
    if (!label || !link.href) return [];
    const key = `${label}\0${link.href}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ label, target: linkTarget(link.href, origin), style: index === 0 ? 'primary' : 'link' }];
  });
}

function assetBindings(page, block) {
  const urls = new Set(block.assetUrls ?? []);
  return (page.assets ?? [])
    .filter((asset) => urls.has(asset.url))
    .map((asset) => ({
      manifestRef: `asset_${hash(asset.url)}`,
      sourceUrl: asset.url,
      kind: asset.kind,
      alt: clean(asset.alt) || clean(asset.label) || null,
      status: 'pending_artifact_materialization',
    }));
}

/**
 * The subset of a block's assets that can occupy an IMAGE field: declared
 * `image` assets that carry their own accessible name. Everything else stays in
 * `assetBindings` (it is still materialized and still accounted) but is never a
 * candidate for a rendered field:
 *   - `media`/`document` kinds are `<source>` srcset variants and file links,
 *     not standalone images;
 *   - an image with no alt text has no item-level text association, and every
 *     asset field in the schema requires a non-empty `alt`. Fabricating one
 *     would be inventing copy, so it is reported unbindable instead.
 * De-duplicated by manifest identity, source order preserved.
 */
function bindableImages(bindings) {
  const seen = new Set();
  return bindings.filter((asset) => {
    if (asset.kind !== 'image' || !asset.alt || seen.has(asset.manifestRef)) return false;
    seen.add(asset.manifestRef);
    return true;
  });
}

function sourceProvenance(data, sourceBlockRefs) {
  const textFields = [];
  const visit = (value, pathParts) => {
    if (typeof value === 'string') {
      const key = pathParts.at(-1);
      if (!['href', 'kind', 'style', 'src', 'id', 'formName', 'role', 'type'].includes(key)) {
        textFields.push({ path: pathParts.join('.'), source: 'extracted', sourceBlockRefs });
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...pathParts, String(index)]));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, [...pathParts, key]);
    }
  };
  visit(data, ['data']);
  return textFields;
}

function stripHeadingAndLinks(text, headings, actions) {
  let body = clean(text);
  for (const heading of headings) {
    if (body.startsWith(heading.text)) body = body.slice(heading.text.length).trim();
  }
  for (const action of [...actions].reverse()) {
    if (body.endsWith(action.label)) body = body.slice(0, -action.label.length).trim();
  }
  return body;
}


// ─── T12.23 structured section types ─────────────────────────────────────────
//
// Seven section types your platform has shipped since W6 that capture could never produce, because
// each is a SHAPE (`faq`, `testimonial`, `stats`, `timeline`, `steps`, `checklist`,
// `comparison_table`) and the crawl used to flatten every shape into `textContent`. browser.mjs now
// keeps `block.structure`; these read it.
//
// DETERMINISTIC, NOT INFERRED. Every builder below reads a real DOM structure — a <dl>, a
// <blockquote>, an <ol>, a <table>. None of them regexes prose looking for something quote-shaped.
// The one place a pattern is applied (a leading year for a timeline, a leading figure for a stat) it
// is applied to a LIST ITEM that is already its own element, so the boundary comes from the
// document, never from a guess about where a sentence ends.
//
// SILENT ON OLD SNAPSHOTS. No `structure` key means every function here returns null and the mapper
// behaves exactly as it did before — replaying a pre-T12.23 snapshot produces the same mapping it
// always did, which is what makes this safe to land ahead of the crawl deploy that fills the key in.
const STATS_MAX = 6;
const TIMELINE_MAX = 8;
const COMPARISON_MAX_COLUMNS = 4;
const COMPARISON_MAX_ROWS = 12;
const CHECKLIST_ITEM_MAX_CHARS = 120;
const STRUCTURED_MIN_LIST_ITEMS = 2;

const cap = (value, max) => {
  const text = clean(value);
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
};

/** A stat reads "1,200 trees planted": a short leading figure, then what it counts. */
const STAT_ITEM_RE = /^([€$£]?\d[\d.,]*\s*(?:%|k|m|bn|\+)?)\s+(.{2,})$/i;
/**
 * A BARE four-digit year is a date, not a quantity. Without this, "1998 Founded in Berlin" matched
 * the stat pattern — 1998 is a leading figure — and a foundation's history came out as a stats
 * strip reading "1998 / Founded in Berlin". A figure that carries a separator, a unit or a currency
 * ("1,200", "20%", "$4m") is unaffected, so the only thing excluded is the shape that was never a
 * stat in the first place.
 */
const BARE_YEAR_RE = /^(?:19|20)\d{2}$/;
/** A milestone leads with a year or a year range, optionally followed by a separator. */
const TIMELINE_ITEM_RE = /^((?:19|20)\d{2}(?:\s*[–—-]\s*(?:(?:19|20)\d{2}|present))?)\s*[:.–—-]?\s+(.{3,})$/i;

const listsOf = (block) => block?.structure?.lists ?? [];

/** Split "Title. The rest of it" into a bounded title and whatever remains. */
const splitTitle = (text, titleMax) => {
  const value = clean(text);
  const boundary = value.search(/[.:—–]\s/);
  if (boundary > 0 && boundary <= titleMax) {
    return { title: cap(value.slice(0, boundary), titleMax), description: clean(value.slice(boundary + 1)) };
  }
  if (value.length <= titleMax) return { title: value, description: '' };
  return { title: cap(value, titleMax), description: value };
};

function buildFaq(context) {
  const entries = context.block?.structure?.qa ?? [];
  if (entries.length === 0) return null;
  const items = entries
    .filter((entry) => clean(entry.q) && clean(entry.a))
    .map((entry) => ({ q: clean(entry.q), a: richText(clean(entry.a)) }));
  if (items.length === 0) return null;
  return { ...(context.headings[0]?.text ? { heading: context.headings[0].text } : {}), items };
}

function buildTestimonial(context) {
  const entries = context.block?.structure?.quotes ?? [];
  const quotes = entries
    .filter((entry) => clean(entry.quote))
    .map((entry) => ({ quote: clean(entry.quote), ...(clean(entry.attribution) ? { attribution: clean(entry.attribution) } : {}) }));
  if (quotes.length === 0) return null;
  return { ...(context.headings[0]?.text ? { heading: context.headings[0].text } : {}), quotes };
}

function buildStats(context) {
  for (const list of listsOf(context.block)) {
    const items = list.items
      .map((item) => STAT_ITEM_RE.exec(clean(item)))
      .filter(Boolean)
      .filter((match) => !BARE_YEAR_RE.test(clean(match[1])))
      .map((match) => ({ value: cap(match[1], 24), label: cap(match[2], 64) }))
      .slice(0, STATS_MAX);
    // The schema's own floor is 2; a single figure is a sentence, not a stat strip.
    if (items.length >= 2) return { ...(context.headings[0]?.text ? { heading: context.headings[0].text } : {}), items };
  }
  return null;
}

function buildTimeline(context) {
  for (const list of listsOf(context.block)) {
    const milestones = list.items
      .map((item) => TIMELINE_ITEM_RE.exec(clean(item)))
      .filter(Boolean)
      .map((match) => {
        const { title, description } = splitTitle(match[2], 64);
        return { label: title, period: cap(match[1], 48), description: clean(description) || title };
      })
      .slice(0, TIMELINE_MAX);
    if (milestones.length >= 2) return { ...(context.headings[0]?.text ? { heading: context.headings[0].text } : {}), milestones };
  }
  return null;
}

function buildSteps(context) {
  // ORDERED lists only. An <ol> is the author stating that sequence matters; inferring steps from a
  // <ul> would silently re-order-ify a plain bullet list.
  for (const list of listsOf(context.block)) {
    if (!list.ordered) continue;
    const items = list.items
      .map((item) => splitTitle(item, 80))
      .filter((entry) => entry.title)
      .map((entry) => ({ title: entry.title, ...(entry.description && entry.description !== entry.title ? { description: entry.description } : {}) }));
    if (items.length >= 1) return { ...(context.headings[0]?.text ? { heading: context.headings[0].text } : {}), items };
  }
  return null;
}

function buildChecklist(context) {
  for (const list of listsOf(context.block)) {
    if (list.ordered) continue;
    const items = list.items.map((item) => clean(item)).filter(Boolean);
    // Short, self-contained bullets. Long ones are prose that happens to be in a <ul>, and a list of
    // links belongs in link_list where the hrefs survive.
    if (items.length < STRUCTURED_MIN_LIST_ITEMS) continue;
    if (items.some((item) => item.length > CHECKLIST_ITEM_MAX_CHARS)) continue;
    if (context.actions.length >= items.length) continue;
    return { ...(context.headings[0]?.text ? { heading: context.headings[0].text } : {}), items };
  }
  return null;
}

function buildComparisonTable(context) {
  for (const table of context.block?.structure?.tables ?? []) {
    const headers = (table.headers ?? []).map((header) => clean(header)).filter(Boolean);
    // The first header names the row axis, so the comparison columns are the rest.
    if (headers.length < 3) continue;
    const columns = headers.slice(1, 1 + COMPARISON_MAX_COLUMNS).map((label) => ({ label: cap(label, 32) }));
    const rows = (table.rows ?? [])
      .map((row) => row.map((cell) => clean(cell)))
      .filter((row) => row.length >= 2 && row[0])
      .slice(0, COMPARISON_MAX_ROWS)
      .map((row) => ({
        label: cap(row[0], 64),
        // A tick or a cross is a boolean in every comparison table ever printed; carrying it as one
        // lets the renderer draw its own mark instead of echoing whatever glyph the source used.
        cells: row.slice(1, 1 + columns.length).map((cell) => (/^(?:✓|✔|yes|included)$/i.test(cell) ? true : /^(?:✕|✗|×|—|-|no|not included)$/i.test(cell) ? false : cap(cell, 48))),
      }));
    if (columns.length >= 2 && rows.length >= 1) {
      return { ...(context.headings[0]?.text ? { heading: context.headings[0].text } : {}), columns, rows };
    }
  }
  return null;
}

/**
 * The structured builders, in descending order of how specific their evidence is. `faq` before
 * `checklist` because a <dl> of questions is unambiguous where a <ul> of short lines is not;
 * `comparison_table` before anything list-shaped because a <table> says the most of all.
 */
export const STRUCTURED_BUILDERS = [
  ['faq', buildFaq],
  ['comparison_table', buildComparisonTable],
  ['testimonial', buildTestimonial],
  // Timeline BEFORE stats: "1998 Founded in Berlin" satisfies both patterns, and a leading year is
  // the more specific claim. Stats additionally refuses a bare year (BARE_YEAR_RE), so the two no
  // longer compete for the same list at all — the ordering is the belt, that filter is the braces.
  ['timeline', buildTimeline],
  ['stats', buildStats],
  ['steps', buildSteps],
  ['checklist', buildChecklist],
];

const STRUCTURED_CONFIDENCE = {
  faq: 0.92,
  comparison_table: 0.9,
  testimonial: 0.88,
  stats: 0.87,
  timeline: 0.87,
  steps: 0.84,
  checklist: 0.8,
};

/**
 * Choose the structured type a block's RECOVERED SHAPE warrants. Returns null for a block with no
 * `structure` key at all — i.e. every pre-T12.23 snapshot — so this can never change how an old
 * capture maps.
 */
function structuredCandidate(context, permitted) {
  if (!context.block?.structure) return null;
  for (const [type, build] of STRUCTURED_BUILDERS) {
    if (!permitted(type)) continue;
    const data = build(context);
    if (data) {
      return { type, data, confidence: STRUCTURED_CONFIDENCE[type], reason: `recovered ${type} structure from the source DOM` };
    }
  }
  return null;
}

function buildForType(type, context) {
  const { block, headings, actions, route } = context;
  const text = clean(block.text?.value);
  const heading = headings[0]?.text;
  const body = stripHeadingAndLinks(text, headings, actions);
  switch (type) {
    case 'hero':
      if (!heading) return null;
      return { heading, ...(body ? { body: richText(body) } : {}), actions };
    case 'lede':
      if (!heading) return null;
      return { heading, ...(body ? { body: richText(body) } : {}), actions };
    case 'prose':
      if (!text) return null;
      return { body: richText(text) };
    case 'bio':
      if (!heading || !body) return null;
      return { heading, body: richText(body), trustNotes: [] };
    case 'contact_form':
      if (!heading) return null;
      return { formName: `contact-${hash(route, 8)}`, heading };
    case 'cta_banner':
      if (actions.length === 0) return null;
      return { ...(heading ? { heading } : {}), ...(body ? { body: richText(body) } : {}), actions };
    case 'link_list':
      if (actions.length === 0) return null;
      return { ...(heading ? { heading } : {}), links: actions };
    // The structured seven. Each returns null without a `structure` key, so an assisted suggestion
    // of one of these against an old snapshot is REJECTED (the block stays declined) rather than
    // coerced into an empty section — the re-validation contract block_classifier is promised.
    case 'faq':
      return buildFaq(context);
    case 'comparison_table':
      return buildComparisonTable(context);
    case 'testimonial':
      return buildTestimonial(context);
    case 'stats':
      return buildStats(context);
    case 'timeline':
      return buildTimeline(context);
    case 'steps':
      return buildSteps(context);
    case 'checklist':
      return buildChecklist(context);
    default:
      return null;
  }
}

const BIO_SIGNAL_RE = /in memory of|our trustees|founder|biograph|trustee/i;

/**
 * Choose the asset-bearing section type a block's shape warrants, and build its
 * data MINUS the asset field (emission binds that — see `bindSectionAssets`).
 *
 * The governing constraint is that RE-TYPING MUST NOT DROP EXTRACTED COPY.
 * `media` and `brand_row` carry a heading and images but no body, so they are
 * only legal for blocks whose text is a label; a block with substantive body
 * copy has to land on `content_split` or `bio`, which carry it — otherwise the
 * block keeps its text type and the asset stays a recorded gap. Returns null
 * when no asset-bearing type fits.
 */
function assetSectionPlan(context, images) {
  const { block, headings, actions, styleNoise } = context;
  const text = clean(block.text?.value);
  const heading = headings[0]?.text;
  // An injected builder style payload is NOT copy, so it is not body text a
  // section has to preserve — and preserving CSS is an explicit non-goal. The
  // block's real evidence is the gallery; the payload reaches no field at all.
  const body = styleNoise ? '' : stripHeadingAndLinks(text, headings, actions);
  const substantive = body.length >= SUBSTANTIVE_BODY_MIN_CHARS;
  const plan = (target, entries) => ({
    target,
    entries: entries.map((asset) => ({ manifestRef: asset.manifestRef, alt: asset.alt })),
  });

  if (substantive && heading && BIO_SIGNAL_RE.test(text.toLowerCase())) {
    return {
      type: 'bio',
      data: { heading, body: richText(body), trustNotes: [] },
      assetPlan: plan('portrait', images.slice(0, 1)),
      confidence: 0.87,
      reason: 'person-focused biography signals with a portrait asset',
    };
  }
  if (substantive && heading && images.length <= CONTENT_SPLIT_MAX_IMAGES) {
    return {
      type: 'content_split',
      data: { heading, body: richText(body), actions },
      assetPlan: plan('images', images),
      confidence: 0.85,
      reason: 'heading plus body copy beside one or two source images',
    };
  }
  if (substantive) return null; // no asset-bearing type can carry this block's copy
  if (images.length >= BRAND_ROW_MIN_LOGOS && actions.length >= 2) {
    return {
      type: 'brand_row',
      data: { ...(heading ? { heading } : {}) },
      assetPlan: plan('logos', images),
      confidence: 0.84,
      reason: 'linked logo or partner strip',
    };
  }
  return {
    type: 'media',
    data: {
      ...(heading ? { heading } : {}),
      layout: images.length === 1 ? 'single' : images.length === 2 ? 'strip' : 'grid',
    },
    assetPlan: plan('items', images),
    confidence: 0.86,
    reason: `image evidence bound as a ${images.length === 1 ? 'single image' : 'gallery'}`,
  };
}

function classifyBlock(context, forcedType) {
  const { page, block, headings, actions, isFirst, images, mediaRetentionAllowed } = context;
  const allowedSections = context.allowedSections ?? 'any';
  const text = clean(block.text?.value);
  const assets = block.assetUrls?.length ?? 0;
  const lowercase = text.toLowerCase();
  const styleNoise = lowercase.includes('--wix-color-') || lowercase.includes('{ --');

  if (forcedType && SUPPORTED_SECTION_TYPES.has(forcedType)) {
    const data = buildForType(forcedType, context);
    if (data) return { type: forcedType, data, confidence: 0.8, reason: 'validated_assisted_type_choice' };
  }
  if (!text) return { gap: ['empty_or_nontext_block', 'prose', 'meaningful textual or structured content'] };
  if (/namee-?mailtopicmessagesend/i.test(lowercase) || /sent\. thank you/i.test(lowercase)) {
    return {
      type: 'contact_form',
      data: buildForType('contact_form', context),
      confidence: 0.98,
      reason: 'fixed contact-form field vocabulary detected',
    };
  }
  if (headings.length >= 3 && (page.blocks?.length ?? 0) <= 3) {
    return {
      gap: [
        'mixed_interactive_detail',
        'prose',
        'separable event metadata, body, registration state, and sharing behavior',
      ],
    };
  }
  // A block whose evidence IS imagery is a candidate, not a decline. This runs
  // ahead of the builder-CSS check on purpose: an injected style payload is a
  // property of the block's TEXT, and the gallery underneath it is real semantic
  // evidence. Only the images and their own alt text reach a field — the CSS
  // never does, which is exactly what the "clean semantic gallery data without
  // injected CSS" gap asked for.
  if (assets >= 2 || (styleNoise && assets >= 1)) {
    if (!mediaRetentionAllowed) {
      return {
        gap: [
          'media_reuse_prohibited_by_policy',
          images.length >= BRAND_ROW_MIN_LOGOS && actions.length >= 2 ? 'brand_row' : 'media',
          'capture policy prohibits media reuse from this source; no asset field may be emitted',
        ],
      };
    }
    if (images.length === 0) {
      return {
        gap: [
          'media_evidence_not_bindable',
          'media',
          'source images with a declared image kind and item-level alt text; ' +
            'srcset variants and unlabelled images cannot occupy an asset field',
        ],
      };
    }
    const plan = assetSectionPlan({ ...context, styleNoise }, images);
    if (plan) return plan;
  }
  if (styleNoise) {
    return { gap: ['embedded_builder_style_payload', 'media', 'clean semantic gallery data without injected CSS'] };
  }
  if (isFirst && headings.length > 0) {
    const type = page.path === '/' && (actions.length > 0 || assets > 0) ? 'hero' : 'lede';
    return {
      type,
      data: buildForType(type, context),
      confidence: type === 'hero' ? 0.93 : 0.91,
      reason: 'first semantic block carries the page heading',
    };
  }
  // Recovered DOM shape outranks every text heuristic below it: a <dl> of questions, a
  // <blockquote>, an <ol> or a <table> is the author STATING the shape, where "compact multi-link
  // block" and "explanatory text fallback" are this mapper guessing from length. A type the page
  // type disallows is skipped here rather than returned — returning it would turn a mappable block
  // into a `section_not_allowed_for_page_type` gap when the text path could still have mapped it.
  const structured = structuredCandidate(context, (type) => allowedSections === 'any' || allowedSections.has(type));
  if (structured) return structured;
  if (/in memory of|our trustees|founder|biograph|trustee/i.test(lowercase) && headings.length > 0) {
    const data = buildForType('bio', context);
    if (data) return { type: 'bio', data, confidence: 0.86, reason: 'person-focused biography signals detected' };
  }
  if (actions.length >= 2 && text.length < 500) {
    const data = buildForType('link_list', context);
    if (data) return { type: 'link_list', data, confidence: 0.82, reason: 'compact multi-link block' };
  }
  if (actions.length >= 1 && text.length < 320) {
    const data = buildForType('cta_banner', context);
    if (data) return { type: 'cta_banner', data, confidence: 0.77, reason: 'compact call-to-action block' };
  }
  if (text.length >= 20) {
    return {
      type: 'prose',
      data: buildForType('prose', context),
      confidence: 0.76,
      reason: 'explanatory text fallback',
    };
  }
  return { gap: ['insufficient_structure', 'prose', 'more semantic or textual evidence'] };
}

/**
 * Add an asset field to a candidate the TEXT path already classified, but only
 * where nothing is lost: `bio` gains a portrait purely additively, and a
 * heading-plus-body block can become `content_split` (which carries heading,
 * body AND actions, so it is a superset of hero/lede/cta_banner data). A
 * re-typing the PageType would refuse is not attempted — that would turn a
 * mapped block into a gap. Returns null when no legal upgrade exists.
 */
function assetUpgrade(result, context, images, allowedSections) {
  const permitted = (type) => allowedSections === 'any' || allowedSections.has(type);
  if (result.type === 'bio') {
    return {
      ...result,
      assetPlan: { target: 'portrait', entries: [{ manifestRef: images[0].manifestRef, alt: images[0].alt }] },
      reason: `${result.reason}; portrait asset bound`,
    };
  }
  if (!['hero', 'lede', 'cta_banner'].includes(result.type)) return null;
  const plan = assetSectionPlan(context, images);
  if (!plan || plan.type !== 'content_split' || !permitted('content_split')) return null;
  // content_split carries heading + body + actions; refuse the upgrade if the
  // text candidate held copy the target shape would not.
  if (typeof result.data.body === 'string' && plan.data.body !== result.data.body) return null;
  return { ...plan, reason: `${plan.reason} (re-typed from ${result.type} to carry its image evidence)` };
}

/**
 * The residue an asset-aware candidate still leaves — enumerated, never hidden.
 * A bound candidate can still carry a gap (T12.10 discipline: `mapped_with_gap`
 * counts as mapped AND stays on the ledger); an unbindable one says exactly why.
 */
const SECTION_TYPES_WITHOUT_ACTIONS = new Set(['media', 'brand_row', 'bio']);

function assetResidueGap(result, bindings, images, actions) {
  const unlabelledImages = bindings.filter((asset) => asset.kind === 'image' && !asset.alt);
  if (result.assetPlan) {
    const bounds = ASSET_FIELD_BOUNDS[result.assetPlan.target];
    const overflow = result.assetPlan.entries.length - bounds.max;
    const droppedActions = SECTION_TYPES_WITHOUT_ACTIONS.has(result.type) ? actions.length : 0;
    const residues = [
      ...(overflow > 0
        ? [
            {
              code: 'media_gallery_exceeds_section_capacity',
              detail:
                `${overflow} further source image(s) beyond the ${bounds.max}-item ${result.type} capacity ` +
                '(a paginated or multi-section gallery placement)',
            },
          ]
        : []),
      ...(unlabelledImages.length > 0
        ? [
            {
              code: 'image_missing_item_level_text_association',
              detail:
                `${unlabelledImages.length} source image(s) carry no alt text, and item-level text ` +
                'association may not be invented',
            },
          ]
        : []),
      ...(droppedActions > 0
        ? [
            {
              code: 'link_actions_not_carried_by_asset_section',
              detail: `${droppedActions} source link action(s) that ${result.type} has no field for`,
            },
          ]
        : []),
    ];
    if (residues.length === 0) return null;
    return {
      code: residues[0].code,
      nearestType: result.type,
      missingCapability: `a governed placement for evidence this ${result.type} cannot hold: ${residues
        .map((residue) => residue.detail)
        .join('; ')}`,
    };
  }
  if (bindings.length === 0) return null;
  if (result.type === 'contact_form' || result.type === 'link_list') return null;
  if (images.length === 0) {
    return {
      code: 'media_evidence_not_bindable',
      nearestType: 'media',
      missingCapability:
        `asset evidence of kind ${[...new Set(bindings.map((asset) => asset.kind))].sort().join('/')} ` +
        'with item-level alt text; srcset variants, documents, and unlabelled images cannot occupy an asset field',
    };
  }
  const nearestType = images.length >= 2 ? 'content_split' : 'media';
  return {
    code: 'section_type_has_no_asset_field',
    nearestType,
    missingCapability:
      `${result.type} has no asset field, and re-typing it to ${nearestType} would drop extracted copy or ` +
      'be refused by this PageType; a legal placement for the image evidence in this block',
  };
}

function screenshotRef(block) {
  return block.screenshots?.find((screenshot) => screenshot.captured)?.path ?? null;
}

function mapPage(page, snapshot, threshold, assistanceByBlock, mediaRetentionAllowed) {
  const origin = snapshot.capture.origin;
  const pageType = page.path === '/' ? 'home' : 'standard';
  const allowedSections = CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS[pageType];
  const reconciled = reconcileBlocks(page);
  const candidates = [];
  const gaps = [];
  for (const [index, block] of reconciled.blocks.entries()) {
    const headings = blockHeadings(page, block);
    const actions = linkActions(block, origin);
    const bindings = assetBindings(page, block);
    const images = mediaRetentionAllowed ? bindableImages(bindings) : [];
    const context = {
      page,
      block,
      headings,
      actions,
      route: page.path,
      isFirst: index === 0,
      images,
      mediaRetentionAllowed,
      allowedSections,
    };
    let result = classifyBlock(context, assistanceByBlock.get(block.id)?.sectionType);
    if (!result.gap && result.data && !result.assetPlan && images.length > 0) {
      result = assetUpgrade(result, context, images, allowedSections) ?? result;
    }
    if (result.gap || result.confidence < threshold || !result.data) {
      const [why, nearestType, missingCapability] = result.gap ?? [
        'below_confidence_threshold',
        result.type,
        `confidence ${result.confidence.toFixed(2)} is below ${threshold.toFixed(2)}`,
      ];
      const gap = {
        gapId: `gap_${hash(block.id)}`,
        blockRef: block.id,
        screenshotRef: screenshotRef(block),
        why,
        nearestType,
        missingCapability,
      };
      gaps.push(gap);
      reconciled.account.set(block.id, { blockRef: block.id, status: 'gap', gapId: gap.gapId });
      continue;
    }

    if (allowedSections !== 'any' && !allowedSections.has(result.type)) {
      const gap = {
        gapId: `gap_${hash(`${block.id}:page_type_disallowed`)}`,
        blockRef: block.id,
        screenshotRef: screenshotRef(block),
        why: 'section_not_allowed_for_page_type',
        nearestType: result.type,
        missingCapability: `${pageType} PageType does not allow ${result.type}; preserve source evidence as a gap rather than coercing it`,
      };
      gaps.push(gap);
      reconciled.account.set(block.id, { blockRef: block.id, status: 'gap', gapId: gap.gapId });
      continue;
    }

    const sectionId = `s_${hash(block.id, 10)}`;
    const candidateId = `candidate_${hash(`${block.id}:${result.type}`)}`;
    const candidate = {
      candidateId,
      sectionType: result.type,
      data: result.data,
      section: { id: sectionId, type: result.type, data: result.data },
      confidence: result.confidence,
      mappingReason: result.reason,
      sourceBlockIds: [block.id],
      screenshotRefs: (block.screenshots ?? []).filter((item) => item.captured).map((item) => item.path),
      assetBindings: bindings,
      // The asset field is deliberately ABSENT from `data`/`section` until
      // emission binds a materialized artifact into it. The plan below is the
      // only channel between the two phases and it carries no source URL.
      ...(result.assetPlan
        ? { assetPlan: { ...result.assetPlan, sectionType: result.type }, assetBindingStatus: 'pending' }
        : {}),
      provenance: {
        textFields: sourceProvenance(result.data, [block.id]),
        // Alt text is extracted copy too — the "item-level text association"
        // the gap report asked for, recorded per planned asset.
        ...(result.assetPlan
          ? {
              assetFields: result.assetPlan.entries.map((entry, position) => ({
                path: `data.${result.assetPlan.target}${result.assetPlan.target === 'portrait' ? '' : `.${position}`}.alt`,
                source: 'extracted',
                sourceBlockRefs: [block.id],
                manifestRef: entry.manifestRef,
              })),
            }
          : {}),
      },
    };
    candidates.push(candidate);
    const secondaryGap = assetResidueGap(result, bindings, images, actions);
    if (secondaryGap) {
      const gap = {
        gapId: `gap_${hash(`${block.id}:${secondaryGap.code}`)}`,
        blockRef: block.id,
        screenshotRef: screenshotRef(block),
        why: secondaryGap.code,
        nearestType: secondaryGap.nearestType,
        missingCapability: secondaryGap.missingCapability,
      };
      gaps.push(gap);
      reconciled.account.set(block.id, {
        blockRef: block.id,
        status: 'mapped_with_gap',
        candidateId,
        gapId: gap.gapId,
      });
    } else {
      reconciled.account.set(block.id, { blockRef: block.id, status: 'mapped', candidateId });
    }
  }

  const title =
    (page.outline ?? []).find((node) => Number.isInteger(node.level) && clean(node.text))?.text ||
    page.title ||
    page.path;
  const pageBody = {
    route: page.path,
    pageType,
    title: clean(title),
    seo: { ...(page.metaDescription ? { description: page.metaDescription } : {}) },
    sections: candidates.map((candidate) => candidate.section),
  };
  return {
    pageRef: page.pageId,
    sourceUrl: page.url,
    pageBody,
    candidates,
    gaps,
    blockAccounting: page.blocks.map(
      (block) =>
        reconciled.account.get(block.id) ?? {
          blockRef: block.id,
          status: 'ignored_noncontent',
          reason: 'not_selected_after_reconciliation',
        }
    ),
  };
}

function dedupeNavItems(items, origin) {
  const seen = new Set();
  return items.flatMap((item) => {
    const label = clean(item.label);
    if (!label || !item.href) return [];
    const key = `${label}\0${item.href}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: `i_${hash(key, 10)}`, label, target: linkTarget(item.href, origin) }];
  });
}

function mapNavigation(snapshot) {
  const first = snapshot.pages[0];
  if (!first) return [];
  const primaryItems = dedupeNavItems(first.navigation?.primary ?? [], snapshot.capture.origin);
  const footerText = clean((first.outline ?? []).find((node) => node.tag === 'footer')?.text);
  const candidates = [];
  if (primaryItems.length > 0) {
    const body = { role: 'header', groups: [{ id: 'g_primary', items: primaryItems }], actions: [] };
    candidates.push({
      candidateId: `navigation_${hash('header')}`,
      role: 'header',
      body,
      confidence: 0.96,
      sourcePageRefs: snapshot.pages.map((page) => page.pageId),
      provenance: { textFields: sourceProvenance(body, [first.pageId]) },
    });
  }
  if (footerText) {
    const body = { role: 'footer', groups: [], footNote: footerText };
    candidates.push({
      candidateId: `navigation_${hash('footer')}`,
      role: 'footer',
      body,
      confidence: 0.9,
      sourcePageRefs: snapshot.pages.map((page) => page.pageId),
      provenance: { textFields: sourceProvenance(body, [first.pageId]) },
    });
  }
  return candidates;
}

export function mapSnapshot(snapshot, options = {}) {
  if (snapshot?.schemaVersion !== 'snapshot.v1' || !Array.isArray(snapshot.pages)) {
    throw new Error('Mapper input must be a snapshot.v1 document with pages.');
  }
  if ((snapshot.diagnostics?.quarantined?.length ?? 0) > 0) {
    throw new Error('Mapper refuses snapshots with quarantined pages.');
  }
  const threshold = options.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) throw new Error('threshold must be 0..1.');
  const suggestions = options.assistance?.suggestions ?? [];
  const assistanceByBlock = new Map(
    suggestions
      .filter((suggestion) => suggestion && typeof suggestion.blockRef === 'string')
      .map((suggestion) => [suggestion.blockRef, suggestion])
  );
  // Media rights come from the policy the CRAWL recorded, and they fail closed:
  // no recorded right means no asset may be planned. Emission independently
  // re-reads the TARGET project registry's rights before binding anything, so a
  // media asset has to clear both the source authorization and the target's.
  const mediaRetentionAllowed = snapshot.capture?.policy?.rights?.media === MEDIA_RETENTION_RIGHT;
  const pages = snapshot.pages.map((page) =>
    mapPage(page, snapshot, threshold, assistanceByBlock, mediaRetentionAllowed)
  );
  const navigationCandidates = mapNavigation(snapshot);
  const allCandidates = pages.flatMap((page) => page.candidates);
  const allGaps = pages.flatMap((page) => page.gaps);
  return {
    schemaVersion: CAPTURE_MAP_SCHEMA_VERSION,
    snapshotSchemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.capture.capturedAt,
    source: {
      targetUrl: snapshot.capture.targetUrl,
      capturedAt: snapshot.capture.capturedAt,
      redacted: snapshot.capture.redacted,
    },
    policy: {
      confidenceThreshold: threshold,
      copyHandling: 'defer_to_target_project_capture_policy',
      emittedTextSource: 'extracted',
      mediaHandling: mediaRetentionAllowed
        ? 'asset_plans_bound_to_first_party_artifacts_at_emission'
        : 'media_reuse_prohibited_by_capture_policy',
      mediaRetentionAllowed,
      assistance: suggestions.length > 0 ? 'provided_type_suggestions_validated_by_builder' : 'none',
    },
    pages,
    navigationCandidates,
    summary: {
      pages: pages.length,
      sectionCandidates: allCandidates.length,
      navigationCandidates: navigationCandidates.length,
      pendingAssetSections: allCandidates.filter((candidate) => candidate.assetPlan).length,
      gaps: allGaps.length,
      sourceBlocks: snapshot.pages.reduce((total, page) => total + page.blocks.length, 0),
      accountedBlocks: pages.reduce((total, page) => total + page.blockAccounting.length, 0),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(await readFile(path.resolve(args.snapshot), 'utf8'));
  const assistance = args.assistance ? JSON.parse(await readFile(path.resolve(args.assistance), 'utf8')) : undefined;
  const threshold = args.threshold === undefined ? undefined : Number(args.threshold);
  const mapping = mapSnapshot(snapshot, { assistance, threshold });
  await writeJson(path.resolve(args.out), mapping);
  console.log(JSON.stringify({ ok: true, out: path.resolve(args.out), ...mapping.summary }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
