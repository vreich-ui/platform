/**
 * content_item node renderer (W7.3, 08-articles-plan §2.3) — the ONE renderer
 * for object-backed article bodies: the public build consumes it via
 * src/utils/blog.ts; admin/canvas previews reuse it so what an editor sees is
 * what a reader gets (bug ⑦ — the dual-renderer drift class — dies here).
 *
 * THE LEAK RULE (the preservation directive's other half): only `public`
 * fields of PUBLIC-visibility nodes reach HTML. `node.private`
 * (strategy/intent/agentNotes), commercial internals, envelope judge/score
 * data — never serialized. The single sanctioned commercial surface is the
 * reader-facing disclosure label + link rel, which exist to be shown.
 * Pinned by the reader-safety projection (object-validate.ts) and tests.
 *
 * Canvas identity: every rendered node is wrapped in a `display:contents`
 * div carrying data-cms-object-id / data-cms-node-id / data-cms-node-kind —
 * the article-body analogue of section-annotations.ts (inert for visitors,
 * the chip anchor for admins).
 *
 * String bodies are PLAIN TEXT: escaped, blank lines split paragraphs,
 * single newlines become <br/>. Rich formatting is rich_text.v1's job
 * (rendered through the W7.1 substrate; embeds are validation-blocked until
 * their resolvers exist, so this renderer passes none).
 */
import { BLOCKS } from '@contentful/rich-text-types';

import { renderRichTextV1Html } from '../richtext/render-html.js';
import type { ContentItemBody, ContentItemNode } from '../../schema/bodies/content-item-v1.js';

export type RenderedArticle = {
  /** The article body HTML (annotated node wrappers included). */
  html: string;
  /** Ceil'd minutes, matching the md pipeline's readingTimeRemarkPlugin. */
  readingTime: number;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Hrefs a rendered link may carry; anything else renders as plain text. */
const SAFE_HREF_RE = /^(https?:\/\/|\/|#|mailto:)/i;

const safeHref = (href: string | undefined): string | undefined => (href && SAFE_HREF_RE.test(href) ? href : undefined);

const plainTextParagraphs = (text: string): string =>
  text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br/>')}</p>`)
    .join('');

const bodyHtml = (body: ContentItemNode['public']['body']): string => {
  if (body === undefined) return '';
  if (typeof body === 'string') return plainTextParagraphs(body);
  // rich_text.v1 document. No embed resolvers on purpose: embeds are blocked
  // at write until they can render; one slipping through throws loudly here
  // (never-silently-drop) rather than emitting a hole.
  return renderRichTextV1Html(body);
};

const relAttr = (node: ContentItemNode): string => {
  const rel = node.commercial?.rel;
  return rel ? ` rel="${escapeHtml(rel)}"` : '';
};

const ctaHtml = (node: ContentItemNode, prominent: boolean): string => {
  const { ctaText, ctaLink } = node.public;
  if (!ctaText) return '';
  const href = safeHref(ctaLink);
  if (!href) return `<p><strong>${escapeHtml(ctaText)}</strong></p>`;
  // `not-prose` + `font-sans`: inside the article's editorial-prose wrap the
  // typography plugin's prose-a color beats .btn-primary's text-white (an
  // invisible label on the filled button) and the serif body font leaks into
  // the label — buttons must render exactly like the site's own.
  const cls = prominent ? 'btn btn-primary font-sans' : 'btn font-sans';
  return `<p class="article-node-cta not-prose"><a class="${cls}" href="${escapeHtml(href)}"${relAttr(node)}>${escapeHtml(ctaText)}</a></p>`;
};

/** Human-readable byte size for the document block ("1.2 MB"). */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const mediaFilename = (src: string): string => (src.split(/[?#]/)[0] ?? '').split('/').pop() ?? '';

/**
 * `type:'document'` — a PDF attached to the article. Renders a download
 * block (filename + size when known) plus an inline <object> preview whose
 * fallback is the same link, so a browser without a PDF viewer still gets
 * the file. NEVER an <img>: that is the broken-image defect this exists to
 * close. The href is the artifact bridge's /pdf/{id}/{sha256}.pdf public path
 * verbatim, which is what verify_article_images' expectedDocuments asserts.
 */
const documentMediaHtml = (
  node: ContentItemNode,
  media: NonNullable<ContentItemNode['public']['media']>,
  src: string
): string => {
  const filename = mediaFilename(media.src) || 'document.pdf';
  const title = media.title ?? node.public.title ?? filename;
  const isPdf = media.contentType === 'application/pdf' || /\.pdf$/i.test(filename);
  const kind = isPdf ? 'PDF' : 'Document';
  const meta = [kind, media.sizeBytes !== undefined ? formatBytes(media.sizeBytes) : undefined]
    .filter(Boolean)
    .join(' · ');
  const href = escapeHtml(src);
  const typeAttr = isPdf ? ' type="application/pdf"' : '';
  const caption = media.caption ? `<figcaption>${escapeHtml(media.caption)}</figcaption>` : '';
  const preview = isPdf
    ? `<object class="article-document-preview w-full aspect-[3/4] max-h-[80vh] rounded-lg border border-gray-200 dark:border-slate-700" data="${href}" type="application/pdf" aria-label="${escapeHtml(title)}">` +
      `<p class="text-sm text-muted">Your browser cannot preview this PDF — <a href="${href}"${relAttr(node)} download="${escapeHtml(filename)}">download ${escapeHtml(filename)}</a>.</p>` +
      `</object>`
    : '';
  return (
    `<figure class="article-node-document not-prose my-6" data-media-type="document">` +
    `<a class="article-document-link flex items-center gap-3 rounded-lg border border-gray-200 dark:border-slate-700 bg-surface px-4 py-3 font-sans no-underline hover:border-primary" href="${href}"${typeAttr}${relAttr(node)} download="${escapeHtml(filename)}">` +
    `<span class="article-document-icon text-2xl" aria-hidden="true">📄</span>` +
    `<span class="flex flex-col"><span class="font-semibold">${escapeHtml(title)}</span>` +
    `<span class="text-sm text-muted">${escapeHtml(filename)}${meta ? ` · ${escapeHtml(meta)}` : ''}</span></span>` +
    `</a>` +
    preview +
    caption +
    `</figure>`
  );
};

const oneMediaHtml = (node: ContentItemNode, media: NonNullable<ContentItemNode['public']['media']>): string => {
  const src = safeHref(media.src);
  if (!src) return '';
  const caption = media.caption ? `<figcaption>${escapeHtml(media.caption)}</figcaption>` : '';
  if (media.type === 'image') {
    return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(media.alt ?? '')}" loading="lazy" decoding="async" />${caption}</figure>`;
  }
  if (media.type === 'document') return documentMediaHtml(node, media, src);
  // video/audio/embed have no inline player yet — render an honest link,
  // never a silent drop.
  const label = media.title ?? (mediaFilename(media.src) || media.type);
  return `<p><a href="${escapeHtml(src)}"${relAttr(node)}>${escapeHtml(label)}</a></p>${caption}`;
};

const mediaHtml = (node: ContentItemNode): string => {
  const media = node.public.media;
  return media ? oneMediaHtml(node, media) : '';
};

/** Multi-image block: each entry renders like a single media image, in order. */
const imagesHtml = (node: ContentItemNode): string => {
  const images = node.public.images;
  if (!images || images.length === 0) return '';
  return images.map((entry) => oneMediaHtml(node, entry)).join('');
};

/**
 * The adSlot MOCKUP BANK (W7.7, Wolf 2026-07-13: "make them look real like
 * served by google or a native ads provider"). Three renderer-owned units,
 * selected by `commercial.creativeId`, rendered ONLY when
 * `commercial.adSlot.provider === 'mock'` — a real provider config (gpt, …)
 * still renders nothing until an actual ad runtime exists; mockups must never
 * masquerade as live inventory. Every unit is honestly labeled Advertisement/
 * Sponsored (exactly like real served units), self-contained (no external
 * assets — deploy-safe), and overridable: node.public title/body/ctaText and
 * commercial sponsorName/destinationUrl replace the canned creative.
 */
type MockAdCreative = { advertiser: string; headline: string; line: string; cta: string };

const MOCK_AD_BANK: Record<string, MockAdCreative> = {
  'mock-leaderboard': {
    advertiser: 'Golden Hour Botanicals',
    headline: 'Barrier-first skincare, formulated with dermatologists',
    line: 'Clinically tested. Fragrance-free. Actually explained.',
    cta: 'Learn more',
  },
  'mock-native': {
    advertiser: 'Golden Hour Botanicals',
    headline: 'The 3-step routine dermatologists keep recommending',
    line: 'Why barrier repair beats 10-step routines — and what to use instead.',
    cta: 'Learn more',
  },
  'mock-rectangle': {
    advertiser: 'Golden Hour Botanicals',
    headline: 'One serum. Four weeks. Visible calm.',
    line: 'See the study results.',
    cta: 'Shop now',
  },
};

const adSlotHtml = (node: ContentItemNode): string => {
  const commercial = node.commercial;
  const slot = commercial?.adSlot;
  if (!slot || slot.provider !== 'mock') return ''; // no ad runtime — wrapper only
  const creativeKey =
    commercial?.creativeId && MOCK_AD_BANK[commercial.creativeId] ? commercial.creativeId : 'mock-native';
  const canned = MOCK_AD_BANK[creativeKey];
  const advertiser = escapeHtml(commercial?.sponsorName ?? commercial?.advertiserName ?? canned.advertiser);
  const headline = escapeHtml(node.public.title ?? canned.headline);
  const line = escapeHtml(typeof node.public.body === 'string' && node.public.body ? node.public.body : canned.line);
  const cta = escapeHtml(node.public.ctaText ?? canned.cta);
  const href = escapeHtml(safeHref(commercial?.destinationUrl ?? node.public.ctaLink) ?? '#');
  const rel = ` rel="${escapeHtml(commercial?.rel ?? 'nofollow sponsored')}"`;
  const adChip =
    '<span class="absolute top-1.5 right-1.5 rounded-sm border border-gray-300 dark:border-slate-600 px-1 text-[10px] leading-4 text-muted" aria-hidden="true">Ad</span>';
  const microLabel = '<p class="mb-1 text-[10px] uppercase tracking-widest text-muted">Advertisement</p>';

  if (creativeKey === 'mock-leaderboard') {
    return (
      `<aside class="article-node-ad not-prose font-sans my-8">${microLabel}` +
      `<a href="${href}"${rel} class="relative block overflow-hidden rounded-md border border-gray-200 dark:border-slate-700 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-slate-800 dark:to-slate-900 px-5 py-4">${adChip}` +
      `<div class="flex flex-wrap items-center gap-x-6 gap-y-2">` +
      `<div class="min-w-0 flex-1"><p class="text-[11px] font-medium text-muted">${advertiser}</p>` +
      `<p class="text-base font-semibold text-default leading-snug">${headline}</p>` +
      `<p class="text-xs text-muted">${line}</p></div>` +
      `<span class="btn-primary font-sans pointer-events-none px-4 py-2 text-sm">${cta}</span>` +
      `</div></a></aside>`
    );
  }
  if (creativeKey === 'mock-rectangle') {
    return (
      `<aside class="article-node-ad not-prose font-sans my-8 flex flex-col items-center">${microLabel}` +
      `<a href="${href}"${rel} class="relative block w-[300px] max-w-full overflow-hidden rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900">${adChip}` +
      `<div class="h-[120px] bg-gradient-to-br from-amber-100 via-orange-100 to-rose-100 dark:from-slate-700 dark:via-slate-800 dark:to-slate-900"></div>` +
      `<div class="p-4"><p class="text-[11px] font-medium text-muted">${advertiser}</p>` +
      `<p class="text-sm font-semibold text-default leading-snug">${headline}</p>` +
      `<p class="mt-1 text-xs text-muted">${line}</p>` +
      `<span class="btn-primary font-sans pointer-events-none mt-3 inline-block px-4 py-1.5 text-xs">${cta}</span>` +
      `</div></a></aside>`
    );
  }
  // mock-native: in-feed sponsored card, the native-provider idiom.
  return (
    `<aside class="article-node-ad not-prose font-sans my-8">` +
    `<a href="${href}"${rel} class="relative flex gap-4 overflow-hidden rounded-md border border-gray-200 dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">${adChip}` +
    `<div class="h-20 w-28 flex-none rounded bg-gradient-to-br from-amber-100 via-orange-100 to-rose-100 dark:from-slate-700 dark:via-slate-800 dark:to-slate-900"></div>` +
    `<div class="min-w-0"><p class="text-[11px] font-medium uppercase tracking-wide text-muted">Sponsored · ${advertiser}</p>` +
    `<p class="text-base font-semibold text-default leading-snug">${headline}</p>` +
    `<p class="mt-0.5 text-xs text-muted">${line}</p>` +
    `<span class="mt-1 inline-block text-xs font-medium text-primary">${cta} →</span>` +
    `</div></a></aside>`
  );
};

const disclosureHtml = (node: ContentItemNode): string => {
  const disclosure = node.commercial?.disclosure;
  if (!disclosure?.required) return '';
  return `<p class="article-node-disclosure text-sm text-muted uppercase tracking-wide">${escapeHtml(disclosure.label ?? 'Sponsored')}</p>`;
};

/**
 * Does a rich_text.v1 body open with a heading-2 block? Such a body already
 * renders the section heading itself, so the node's own `public.title` must
 * NOT emit a second identical <h2> above it — otherwise every titled node
 * shows its heading twice on the live article (T9.16 chat-drive finding).
 * Plain-string bodies never carry headings, so they never suppress the title.
 */
const bodyOpensWithHeading2 = (body: ContentItemNode['public']['body']): boolean => {
  if (!body || typeof body === 'string') return false;
  return body.content[0]?.nodeType === BLOCKS.HEADING_2;
};

const headerHtml = (node: ContentItemNode): string => {
  const { eyebrow, title } = node.public;
  const eyebrowHtml = eyebrow
    ? `<p class="article-node-eyebrow text-sm uppercase tracking-wide text-muted">${escapeHtml(eyebrow)}</p>`
    : '';
  // T9.16: when the body already opens with a heading-2, THAT block is the
  // section heading — emitting the title as another <h2> renders it twice.
  const titleHtml = title && !bodyOpensWithHeading2(node.public.body) ? `<h2>${escapeHtml(title)}</h2>` : '';
  return eyebrowHtml + titleHtml;
};

const itemsHtml = (node: ContentItemNode): string => {
  const items = node.public.items;
  if (!items || items.length === 0) return '';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
};

/** One node's inner HTML (no wrapper). Public-visibility nodes only. */
const nodeHtml = (node: ContentItemNode): string => {
  switch (node.kind) {
    case 'content':
      return (
        disclosureHtml(node) +
        headerHtml(node) +
        bodyHtml(node.public.body) +
        itemsHtml(node) +
        mediaHtml(node) +
        imagesHtml(node) +
        ctaHtml(node, false)
      );
    case 'action':
      return disclosureHtml(node) + headerHtml(node) + bodyHtml(node.public.body) + ctaHtml(node, true);
    case 'placement': {
      const presentation = node.rendering?.presentation;
      if (presentation === 'offerInline' || presentation === 'offerCard') {
        const inner =
          disclosureHtml(node) + headerHtml(node) + bodyHtml(node.public.body) + itemsHtml(node) + ctaHtml(node, true);
        return presentation === 'offerCard'
          ? `<aside class="article-node-offer not-prose border rounded-lg p-6 my-6">${inner}</aside>`
          : `<aside class="article-node-offer my-6">${inner}</aside>`;
      }
      // adSlot: the MOCK provider renders a bank unit (W7.7); real provider
      // configs still render nothing (no ad runtime — the wrapper still
      // emits, so the canvas can address the node).
      return adSlotHtml(node);
    }
    case 'interactive': {
      // No public chat runtime on articles yet; the invitation text is the
      // one reader-facing field.
      const invitation = node.chat?.invitationText;
      return invitation
        ? `<aside class="article-node-chat my-6"><p><em>${escapeHtml(invitation)}</em></p></aside>`
        : '';
    }
  }
};

const WORDS_PER_MINUTE = 200;

export const renderArticleNodes = (objectId: string, body: ContentItemBody): RenderedArticle => {
  const rendered: string[] = [];
  // T13.5 (W13): an article with tracking.enabled:false opts every node
  // wrapper out — the loader skips [data-cms-track="off"] subtrees.
  const trackingOffAttr = body.tracking?.enabled === false ? ' data-cms-track="off"' : '';
  for (const node of body.nodes) {
    if ((node.visibility ?? 'public') !== 'public') continue; // never-render-private
    rendered.push(
      `<div style="display:contents" data-cms-object-id="${escapeHtml(objectId)}" data-cms-node-id="${escapeHtml(node.id)}" data-cms-node-kind="${escapeHtml(node.kind)}"${trackingOffAttr}>${nodeHtml(node)}</div>`
    );
  }
  const html = rendered.join('');
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text ? text.split(' ').length : 0;
  return { html, readingTime: Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)) };
};
