/**
 * Article publish-readiness evaluation helper.
 * Returns grouped criteria — no numeric score, no fake percentage.
 * Structured so a future scoring algorithm can be added by adding weights.
 */

import type { ArticleBodyNode } from '../../schema/article-content-v1.js';

/**
 * `info` (W6 D4) is a TRUE statement about the object that is not an ask.
 * `optional` means "you could add this"; `warning` means "you probably should";
 * `missing` blocks. `info` means "this is how it is, and that is fine" — the
 * tier that was absent when a criterion needed to report a fact rather than a
 * shortfall. `summarize` (object-validate.ts) collects warnings on
 * `status === 'warning'`, so an `info` criterion is never an operator action
 * item and is never a blocker.
 */
export type CriterionStatus = 'complete' | 'warning' | 'missing' | 'optional' | 'info';

export type ReadinessCriterion = {
  id: string;
  label: string;
  status: CriterionStatus;
  message: string;
  weight?: number;
};

export type ReadinessGroup = {
  id: string;
  label: string;
  criteria: ReadinessCriterion[];
};

export type ReadinessInput = {
  title?: string;
  excerpt?: string;
  author?: string;
  publishDate?: string;
  articlePath?: string;
  seoDescription?: string;
  category?: string;
  tags?: string[];
  nodes?: ArticleBodyNode[];
  lockHeld?: boolean;
  canonicalSaved?: boolean;
  agentLockPresent?: boolean;
};

// ─── slug validation ──────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug.trim());
}

// ─── node inspection helpers ──────────────────────────────────────────────────

function publicNodes(nodes: ArticleBodyNode[]): ArticleBodyNode[] {
  return nodes.filter((n) => !n.visibility || n.visibility === 'public');
}

function hasHeadings(nodes: ArticleBodyNode[]): boolean {
  return publicNodes(nodes).some((n) => {
    const body = n.public.body ?? '';
    const title = n.public.title ?? '';
    return body.includes('<h2') || body.includes('<h3') || title.length > 0;
  });
}

function hasIntro(nodes: ArticleBodyNode[]): boolean {
  const pub = publicNodes(nodes);
  if (pub.length === 0) return false;
  const first = pub[0];
  return Boolean(first.public.body?.trim() || first.public.title?.trim());
}

function hasConclusion(nodes: ArticleBodyNode[]): boolean {
  const pub = publicNodes(nodes);
  if (pub.length < 2) return false;
  const last = pub[pub.length - 1];
  const body = (last.public.body ?? '').toLowerCase();
  const title = (last.public.title ?? '').toLowerCase();
  const conclusionWords = ['conclusion', 'summary', 'takeaway', 'key point', 'bottom line', 'in summary', 'in short'];
  return conclusionWords.some((w) => body.includes(w) || title.includes(w));
}

function isSourceSection(node: ArticleBodyNode): boolean {
  const title = (node.public.title ?? '').toLowerCase();
  const eyebrow = (node.public.eyebrow ?? '').toLowerCase();
  return (
    title.includes('source') ||
    title.includes('further reading') ||
    eyebrow.includes('source') ||
    eyebrow.includes('further reading')
  );
}

function hasSources(nodes: ArticleBodyNode[]): boolean {
  return publicNodes(nodes).some(isSourceSection);
}

const RAW_URL_RE = /https?:\/\/[^\s<>"]+/;

function sourcesHaveRawUrls(nodes: ArticleBodyNode[]): boolean {
  return publicNodes(nodes)
    .filter(isSourceSection)
    .some((n) => {
      const bodyHasUrl = RAW_URL_RE.test(n.public.body ?? '');
      const itemsHaveRawUrl = (n.public.items ?? []).some((item) => RAW_URL_RE.test(item) && !item.includes(' '));
      return bodyHasUrl || itemsHaveRawUrl;
    });
}

function hasImageNodes(nodes: ArticleBodyNode[]): boolean {
  return publicNodes(nodes).some((n) => n.public.media !== undefined);
}

function imagesMissingAlt(nodes: ArticleBodyNode[]): boolean {
  return publicNodes(nodes)
    .filter((n) => n.public.media !== undefined)
    .some((n) => !n.public.media?.alt?.trim());
}

const PLACEHOLDER_STRINGS = ['lorem ipsum', 'placeholder', 'todo', '[insert', 'coming soon', '...', 'tbd', 'xxx'];

function hasPlaceholderText(nodes: ArticleBodyNode[]): boolean {
  return publicNodes(nodes).some((n) => {
    const body = (n.public.body ?? '').toLowerCase();
    const title = (n.public.title ?? '').toLowerCase();
    return PLACEHOLDER_STRINGS.some((p) => body.includes(p) || title.includes(p));
  });
}

function hasEmptyBlocks(nodes: ArticleBodyNode[]): boolean {
  return publicNodes(nodes).some((n) => {
    const hasBody = Boolean(n.public.body?.trim());
    const hasTitle = Boolean(n.public.title?.trim());
    const hasItems = (n.public.items?.length ?? 0) > 0;
    const hasMedia = n.public.media !== undefined;
    const hasCta = Boolean(n.public.ctaText?.trim());
    return !hasBody && !hasTitle && !hasItems && !hasMedia && !hasCta;
  });
}

// ─── evaluator ────────────────────────────────────────────────────────────────

export function evaluateReadiness(input: ReadinessInput): ReadinessGroup[] {
  const {
    title = '',
    excerpt = '',
    author = '',
    publishDate = '',
    articlePath = '',
    seoDescription = '',
    category = '',
    tags = [],
    nodes = [],
    lockHeld = false,
    canonicalSaved = false,
    agentLockPresent = false,
  } = input;

  const groups: ReadinessGroup[] = [];

  // ── Metadata ──────────────────────────────────────────────────────────────
  {
    const criteria: ReadinessCriterion[] = [];

    criteria.push({
      id: 'meta_title',
      label: 'Title',
      status: title.trim() ? 'complete' : 'missing',
      message: title.trim() ? '' : 'Title is required before publishing.',
      weight: 10,
    });

    criteria.push({
      id: 'meta_excerpt',
      label: 'Excerpt',
      status: excerpt.trim() ? 'complete' : 'missing',
      message: excerpt.trim() ? '' : 'Excerpt is required before publishing.',
      weight: 8,
    });

    criteria.push({
      id: 'meta_author',
      label: 'Author',
      status: author.trim() ? 'complete' : 'missing',
      message: author.trim() ? '' : 'Author is required before publishing.',
      weight: 6,
    });

    criteria.push({
      id: 'meta_publish_date',
      label: 'Publish date',
      status: publishDate.trim() ? 'complete' : 'missing',
      message: publishDate.trim() ? '' : 'Publish date is required before publishing.',
      weight: 6,
    });

    criteria.push({
      id: 'meta_article_path',
      label: 'Article path',
      status: articlePath.trim() ? 'complete' : 'missing',
      message: articlePath.trim() ? '' : 'Article path must be generated (enter a title first).',
      weight: 10,
    });

    criteria.push({
      id: 'meta_seo',
      label: 'SEO description',
      status: seoDescription.trim() ? 'complete' : 'warning',
      message: seoDescription.trim() ? '' : 'SEO description improves search visibility.',
      weight: 5,
    });

    criteria.push({
      id: 'meta_category',
      label: 'Category / tags',
      status: category.trim() || tags.length > 0 ? 'complete' : 'optional',
      message: '',
      weight: 3,
    });

    groups.push({ id: 'metadata', label: 'Metadata', criteria });
  }

  // ── Content structure ─────────────────────────────────────────────────────
  {
    const criteria: ReadinessCriterion[] = [];
    const hasNodes = nodes.length > 0 && publicNodes(nodes).length > 0;

    criteria.push({
      id: 'content_body',
      label: 'Article body',
      status: hasNodes ? 'complete' : 'missing',
      message: hasNodes ? '' : 'No article body nodes found.',
      weight: 15,
    });

    if (hasNodes) {
      criteria.push({
        id: 'content_headings',
        label: 'Headings present',
        status: hasHeadings(nodes) ? 'complete' : 'warning',
        message: hasHeadings(nodes) ? '' : 'No headings found. Consider adding section titles.',
        weight: 4,
      });

      criteria.push({
        id: 'content_intro',
        label: 'Introduction present',
        status: hasIntro(nodes) ? 'complete' : 'warning',
        message: hasIntro(nodes) ? '' : 'First block appears empty.',
        weight: 4,
      });

      criteria.push({
        id: 'content_conclusion',
        label: 'Conclusion or summary',
        status: hasConclusion(nodes) ? 'complete' : 'optional',
        message: hasConclusion(nodes) ? '' : 'No obvious conclusion found. Consider adding a summary.',
        weight: 3,
      });
    }

    groups.push({ id: 'content', label: 'Content structure', criteria });
  }

  // ── Sources ───────────────────────────────────────────────────────────────
  {
    const criteria: ReadinessCriterion[] = [];
    const srcExists = hasSources(nodes);
    const rawUrls = sourcesHaveRawUrls(nodes);

    criteria.push({
      id: 'sources_exist',
      label: 'Sources section',
      status: srcExists ? 'complete' : 'optional',
      message: srcExists ? '' : 'No sources section found.',
      weight: 3,
    });

    if (srcExists) {
      criteria.push({
        id: 'sources_links',
        label: 'Source links (no raw URLs)',
        status: rawUrls ? 'warning' : 'complete',
        message: rawUrls ? 'Raw URLs visible in source items — use titled links.' : '',
        weight: 2,
      });
    }

    groups.push({ id: 'sources', label: 'Sources', criteria });
  }

  // ── Media ─────────────────────────────────────────────────────────────────
  {
    const criteria: ReadinessCriterion[] = [];
    const imgNodes = hasImageNodes(nodes);

    if (imgNodes) {
      criteria.push({
        id: 'media_alt',
        label: 'Image alt text',
        status: imagesMissingAlt(nodes) ? 'warning' : 'complete',
        message: imagesMissingAlt(nodes) ? 'One or more images are missing alt text.' : '',
        weight: 4,
      });
    } else {
      criteria.push({
        id: 'media_present',
        label: 'Media',
        status: 'optional',
        message: 'No image nodes found.',
        weight: 2,
      });
    }

    groups.push({ id: 'media', label: 'Media', criteria });
  }

  // ── Editorial quality ─────────────────────────────────────────────────────
  {
    const criteria: ReadinessCriterion[] = [];
    const hasNodes = publicNodes(nodes).length > 0;

    if (hasNodes) {
      criteria.push({
        id: 'editorial_empty',
        label: 'No empty blocks',
        status: hasEmptyBlocks(nodes) ? 'warning' : 'complete',
        message: hasEmptyBlocks(nodes) ? 'One or more blocks have no content.' : '',
        weight: 4,
      });

      criteria.push({
        id: 'editorial_placeholder',
        label: 'No placeholder text',
        status: hasPlaceholderText(nodes) ? 'warning' : 'complete',
        message: hasPlaceholderText(nodes) ? 'Possible placeholder text detected.' : '',
        weight: 4,
      });
    }

    groups.push({ id: 'editorial', label: 'Editorial quality', criteria });
  }

  // ── Publishing safety ─────────────────────────────────────────────────────
  {
    const criteria: ReadinessCriterion[] = [];

    criteria.push({
      id: 'safety_lock',
      label: 'Editor lock held',
      status: lockHeld ? 'complete' : 'missing',
      message: lockHeld ? '' : 'Acquire the edit lock before publishing.',
      weight: 8,
    });

    criteria.push({
      id: 'safety_agent',
      label: 'No active agent lock',
      status: agentLockPresent ? 'warning' : 'complete',
      message: agentLockPresent ? 'An agent currently holds the lock. Wait or force-release.' : '',
      weight: 6,
    });

    criteria.push({
      id: 'safety_saved',
      label: 'Canonical record saved',
      status: canonicalSaved ? 'complete' : 'missing',
      message: canonicalSaved ? '' : 'Save metadata to the workflow record before publishing.',
      weight: 8,
    });

    groups.push({ id: 'safety', label: 'Publishing safety', criteria });
  }

  return groups;
}

/**
 * Derive a provisional readiness label from evaluated groups.
 * Returns 'missing' | 'warning' | 'ready'.
 */
export function readinessLevel(groups: ReadinessGroup[]): 'missing' | 'warning' | 'ready' {
  const all = groups.flatMap((g) => g.criteria);
  if (all.some((c) => c.status === 'missing')) return 'missing';
  if (all.some((c) => c.status === 'warning')) return 'warning';
  return 'ready';
}
