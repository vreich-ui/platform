// Pure, dependency-free artifact-path helpers, split out of
// packages/core/server/lib/artifact-trust.ts on 2026-09-16 so that
// packages/core/app/components/Logo.astro (an Astro component that resolves
// its <img src> at BUILD time) can call publicPathForArtifactRef without
// pulling in artifact-trust.ts's transitive imports (./artifact-index.js ->
// ./blob-list.js -> Netlify Blobs, node:path, node:crypto), none of which
// are usable in that context. This module must stay import-free — that is
// the whole reason it exists. artifact-trust.ts re-exports these four names
// unchanged so every existing caller keeps working.

/** Matches a Major Key artifact reference: {image|pdf}/{id}/{sha256-64-hex}.{ext} */
export const MAJOR_KEY_ARTIFACT_REF_RE = /^(image|pdf)\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i;

/**
 * The PUBLIC, servable path for a raw Major Key artifact ref — the inverse of
 * the netlify redirects (`/img/* → get-public-image?blobKey=image/:splat`,
 * `/pdf/* → get-public-pdf?blobKey=pdf/:splat`). A raw blob key
 * (`image/<id>/<sha>.ext`) is NOT servable as-is; the browser resolves it as a
 * relative path (404) and Astro's `<Image>`/`getImage` throws
 * `LocalImageUsedWrongly`. Renderable `src`/`ogImage`/`portrait.src` fields
 * must carry THIS path — only the trusted `*AssetRef` fields hold the raw ref.
 * Returns the input unchanged when it is not a raw Major Key ref.
 */
export const publicPathForArtifactRef = (ref: string): string => {
  if (!MAJOR_KEY_ARTIFACT_REF_RE.test(ref)) return ref;
  // Case-INSENSITIVE on the kind prefix, because the regex above already is.
  // A case-sensitive `startsWith('pdf/')` sent `PDF/<id>/<sha>.pdf` down the
  // image branch and returned `/img/` + slice(6) — a mangled `/img/D/<id>/…`
  // that resolves to nothing. Unreachable through the governed path
  // (artifactKind comes from a fixed lowercase set) but wrong, and CMS-Agent's
  // mirror of this function (src/agent/workspace/sitePrefetch.ts) already
  // lowercased — so this is also what stops the two from drifting.
  return /^pdf\//i.test(ref) ? `/pdf/${ref.slice('pdf/'.length)}` : `/img/${ref.slice('image/'.length)}`;
};

/** Matches the PUBLIC servable path form: /img|/pdf/{id}/{sha256}.{ext} (see publicPathForArtifactRef). */
export const PUBLIC_ARTIFACT_PATH_RE = /^\/(img|pdf)\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i;

/**
 * The inverse of publicPathForArtifactRef: a /img|/pdf public path back to its
 * raw Major Key blobKey (for artifact-index lookups). Returns the input
 * unchanged when it is not a public artifact path.
 */
export const rawArtifactRefForPublicPath = (path: string): string => {
  if (!PUBLIC_ARTIFACT_PATH_RE.test(path)) return path;
  return path.startsWith('/pdf/') ? `pdf/${path.slice('/pdf/'.length)}` : `image/${path.slice('/img/'.length)}`;
};
