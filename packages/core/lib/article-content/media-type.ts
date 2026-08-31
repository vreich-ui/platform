/**
 * content_item node media TYPE discipline — one pure module shared by the
 * patch engine (object-patch-apply.ts), the validator (object-validate.ts)
 * and the edit-mode form (ui.ts).
 *
 * Why this exists (Wolf, 2026-08): a PDF patched onto a node used to land as
 * `{type:'image', src:'/pdf/…'}` — the type was defaulted, never derived —
 * and the live page rendered a broken <img>. The rule now:
 *
 *   - `media.type` absent  → INFER it from the src (or a supplied
 *     contentType). `.pdf` / application/pdf → 'document'; an image
 *     extension / image/* → 'image'. Anything else is REFUSED with an error
 *     naming the src — never guessed as 'image'.
 *   - `media.type` present → kept, but it must AGREE with what the src says
 *     when the src says anything (image ⇄ document mismatch is refused).
 *     video/audio/embed carry no src-shape rule here.
 *
 * Public artifact paths mirror the artifact bridge (artifact-trust.ts):
 * images serve as /img/{id}/{sha256}.{ext}, PDFs as /pdf/{id}/{sha256}.pdf.
 */

export type InferableMediaType = 'image' | 'document';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg']);
const DOCUMENT_EXTENSIONS = new Set(['pdf']);

const PUBLIC_IMG_PATH_RE = /^\/img\//;
const PUBLIC_PDF_PATH_RE = /^\/pdf\//;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The lowercase extension of a src (path or URL), query/hash stripped; '' when none. */
export const mediaSrcExtension = (src: string): string => {
  const withoutQuery = src.split(/[?#]/)[0] ?? '';
  const last = withoutQuery.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return '';
  return last.slice(dot + 1).toLowerCase();
};

/**
 * What the src (and, when given, contentType) SAY the media is. `undefined`
 * when neither carries a recognizable signal — the caller must then refuse
 * rather than default.
 */
export const inferMediaType = (src: string, contentType?: string): InferableMediaType | undefined => {
  const normalizedContentType = (contentType ?? '').trim().toLowerCase().split(';')[0] ?? '';
  if (normalizedContentType === 'application/pdf') return 'document';
  if (normalizedContentType.startsWith('image/')) return 'image';

  const trimmed = src.trim();
  if (!trimmed) return undefined;
  // The extension is the rendering signal (what the browser will get); the
  // bridge's route prefix (/img, /pdf) only breaks the tie for an
  // extension-less path.
  const extension = mediaSrcExtension(trimmed);
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (PUBLIC_PDF_PATH_RE.test(trimmed)) return 'document';
  if (PUBLIC_IMG_PATH_RE.test(trimmed)) return 'image';
  return undefined;
};

export type MediaTypeResolution =
  | { ok: true; type: string; inferred: boolean }
  | { ok: false; reason: 'unknown_src' | 'type_mismatch'; message: string };

/**
 * Resolve the effective `type` for one media object at `path`.
 *
 * - explicit type + src agrees (or says nothing) → ok, kept.
 * - explicit type contradicted by the src (image ⇄ document) → refused.
 * - no type, inferable src → ok, inferred.
 * - no type, opaque src → refused (never 'image' by default).
 */
export const resolveMediaType = (
  path: string,
  media: { type?: unknown; src?: unknown; contentType?: unknown }
): MediaTypeResolution => {
  const src = typeof media.src === 'string' ? media.src : '';
  const contentType = typeof media.contentType === 'string' ? media.contentType : undefined;
  const explicit = typeof media.type === 'string' && media.type.length > 0 ? media.type : undefined;
  const inferred = inferMediaType(src, contentType);

  if (explicit !== undefined) {
    if (inferred !== undefined && (explicit === 'image' || explicit === 'document') && inferred !== explicit) {
      const hint =
        inferred === 'document'
          ? `Use {type:"document"} (rendered as a download/embed block), never an <img>.`
          : `Use {type:"image"} — a document media node must point at a PDF (/pdf/{id}/{sha256}.pdf).`;
      return {
        ok: false,
        reason: 'type_mismatch',
        message: `${path}.type is "${explicit}" but its src "${src}" is a ${inferred === 'document' ? 'PDF document' : 'image'}. ${hint}`,
      };
    }
    return { ok: true, type: explicit, inferred: false };
  }

  if (inferred !== undefined) return { ok: true, type: inferred, inferred: true };

  return {
    ok: false,
    reason: 'unknown_src',
    message:
      `${path}.type is missing and cannot be inferred from src "${src || '(empty)'}"` +
      `${contentType ? ` (contentType "${contentType}")` : ''}. ` +
      `Pass media.type explicitly ("image" for /img/{id}/{sha256}.{png|jpg|webp|…}, "document" for /pdf/{id}/{sha256}.pdf, ` +
      `or video/audio/embed) — the type is never defaulted to "image".`,
  };
};

export class MediaTypeError extends Error {
  readonly reason: 'unknown_src' | 'type_mismatch';
  readonly path: string;

  constructor(path: string, reason: 'unknown_src' | 'type_mismatch', message: string) {
    super(message);
    this.name = 'MediaTypeError';
    this.reason = reason;
    this.path = path;
  }
}

/**
 * Normalize one media object in place: stamps an inferred `type` when it is
 * missing, throws MediaTypeError when it cannot be inferred or contradicts
 * the src. A media object with no src and no type is left alone (the body
 * schema reports the missing discriminant; there is nothing to infer from).
 */
export const normalizeMediaObject = (path: string, media: Record<string, unknown>): void => {
  const src = typeof media.src === 'string' ? media.src : '';
  const hasType = typeof media.type === 'string' && media.type.length > 0;
  if (!hasType && !src) return;
  const resolution = resolveMediaType(path, media);
  if (!resolution.ok) throw new MediaTypeError(path, resolution.reason, resolution.message);
  if (resolution.inferred) media.type = resolution.type;
};

/**
 * Normalize a whole article node's `public.media` and `public.images[]` in
 * place (see normalizeMediaObject). `path` prefixes the error locations.
 */
export const normalizeArticleNodeMedia = (node: Record<string, unknown>, path = 'node'): void => {
  const pub = node.public;
  if (!isRecord(pub)) return;
  if (isRecord(pub.media)) normalizeMediaObject(`${path}.public.media`, pub.media);
  if (Array.isArray(pub.images)) {
    pub.images.forEach((entry, index) => {
      if (isRecord(entry)) normalizeMediaObject(`${path}.public.images.${index}`, entry);
    });
  }
};

/**
 * update_node deep-merges `fields` over the existing node. Normalize the
 * media parts of `fields` AGAINST the node they will merge into: a `src`
 * change without a `type` re-derives the type (a stale 'image' must not
 * survive a PDF landing on the node); an explicit `type` is validated
 * against the effective src; `images` (arrays replace wholesale) normalize
 * standalone. Mutates `fields` so the applied op — and its history capture —
 * carry the resolved type.
 */
export const normalizeArticleNodeMediaFields = (
  existingNode: Record<string, unknown>,
  fields: Record<string, unknown>,
  path = 'fields'
): void => {
  const pub = fields.public;
  if (!isRecord(pub)) return;

  if (isRecord(pub.media)) {
    const patch = pub.media;
    const existingPub = isRecord(existingNode.public) ? existingNode.public : undefined;
    const existing = existingPub && isRecord(existingPub.media) ? existingPub.media : undefined;
    const touchesSrc = typeof patch.src === 'string' || typeof patch.contentType === 'string';
    const explicitType = typeof patch.type === 'string' && patch.type.length > 0 ? patch.type : undefined;
    if (touchesSrc || explicitType !== undefined) {
      const existingType = typeof existing?.type === 'string' ? existing.type : undefined;
      const effective = {
        src: typeof patch.src === 'string' ? patch.src : existing?.src,
        contentType: typeof patch.contentType === 'string' ? patch.contentType : existing?.contentType,
        // A src change without a type RE-DERIVES the type when the node is
        // (or could be mistaken for) an image/document — the existing type is
        // exactly what a stale default looks like. video/audio/embed nodes
        // have no src-shape rule and keep their type across a src change.
        type:
          explicitType ??
          (existingType !== undefined && existingType !== 'image' && existingType !== 'document'
            ? existingType
            : undefined),
      };
      const resolution = resolveMediaType(`${path}.public.media`, effective);
      if (!resolution.ok) throw new MediaTypeError(`${path}.public.media`, resolution.reason, resolution.message);
      if (resolution.inferred) patch.type = resolution.type;
    }
  }

  if (Array.isArray(pub.images)) {
    pub.images.forEach((entry, index) => {
      if (isRecord(entry)) normalizeMediaObject(`${path}.public.images.${index}`, entry);
    });
  }
};
