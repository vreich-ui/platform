#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { writeJson } from './snapshot-v1.mjs';

export const CAPTURE_MAP_SCHEMA_VERSION = 'capture-map.v1';
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.72;

const SUPPORTED_SECTION_TYPES = new Set(['hero', 'lede', 'prose', 'bio', 'contact_form', 'cta_banner', 'link_list']);
// Keep this capture-side guard aligned with the governed PageType registry.
// The focused mapper test compares it to the live definition so registry drift
// fails closed before a capture artifact can be emitted.
export const CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS = {
  home: new Set(['hero', 'checklist', 'content_grid', 'bio', 'newsletter_signup', 'shared_ref']),
  standard: 'any',
};

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
      alt: clean(asset.alt) || null,
      status: 'pending_artifact_materialization',
    }));
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
    default:
      return null;
  }
}

function classifyBlock(context, forcedType) {
  const { page, block, headings, actions, isFirst } = context;
  const text = clean(block.text?.value);
  const assets = block.assetUrls?.length ?? 0;
  const lowercase = text.toLowerCase();

  if (forcedType && SUPPORTED_SECTION_TYPES.has(forcedType)) {
    const data = buildForType(forcedType, context);
    if (data) return { type: forcedType, data, confidence: 0.8, reason: 'validated_assisted_type_choice' };
  }
  if (!text) return { gap: ['empty_or_nontext_block', 'prose', 'meaningful textual or structured content'] };
  if (lowercase.includes('--wix-color-') || lowercase.includes('{ --')) {
    return { gap: ['embedded_builder_style_payload', 'media', 'clean semantic gallery data without injected CSS'] };
  }
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
  if (assets >= 2 && text.length < 220) {
    return {
      gap: [
        actions.length >= 2 ? 'logo_or_partner_strip_requires_assets' : 'media_gallery_requires_assets',
        actions.length >= 2 ? 'brand_row' : 'media',
        'materialized first-party asset references and item-level text association',
      ],
    };
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

function visualGap(candidate, bindings) {
  if (bindings.length === 0) return null;
  if (candidate.sectionType === 'contact_form' || candidate.sectionType === 'link_list') return null;
  const nearestType = bindings.length >= 2 ? 'content_split' : candidate.sectionType === 'bio' ? 'bio' : 'media';
  return {
    code: 'unmaterialized_visual_evidence',
    nearestType,
    missingCapability:
      'first-party artifact materialization plus a schema-safe asset field; source URLs cannot be emitted as hotlinks',
  };
}

function screenshotRef(block) {
  return block.screenshots?.find((screenshot) => screenshot.captured)?.path ?? null;
}

function mapPage(page, snapshot, threshold, assistanceByBlock) {
  const origin = snapshot.capture.origin;
  const pageType = page.path === '/' ? 'home' : 'standard';
  const allowedSections = CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS[pageType];
  const reconciled = reconcileBlocks(page);
  const candidates = [];
  const gaps = [];
  for (const [index, block] of reconciled.blocks.entries()) {
    const headings = blockHeadings(page, block);
    const actions = linkActions(block, origin);
    const context = { page, block, headings, actions, route: page.path, isFirst: index === 0 };
    const result = classifyBlock(context, assistanceByBlock.get(block.id)?.sectionType);
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
    const bindings = assetBindings(page, block);
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
      provenance: { textFields: sourceProvenance(result.data, [block.id]) },
    };
    candidates.push(candidate);
    const secondaryGap = visualGap(candidate, bindings);
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
  const pages = snapshot.pages.map((page) => mapPage(page, snapshot, threshold, assistanceByBlock));
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
      mediaHandling: 'manifest_refs_only_pending_artifact_materialization',
      assistance: suggestions.length > 0 ? 'provided_type_suggestions_validated_by_builder' : 'none',
    },
    pages,
    navigationCandidates,
    summary: {
      pages: pages.length,
      sectionCandidates: allCandidates.length,
      navigationCandidates: navigationCandidates.length,
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
