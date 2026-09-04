/**
 * Store-backed validation context (the "make the advertised boundaries bite"
 * half of the object-contract work). The generic object write path
 * (object-store.ts / admin-object.ts) previously called `handleObjectVerb` with
 * NO validation context, so every resolver-dependent criterion — reference
 * integrity, PageType allowed/required sections, route uniqueness, template
 * registry membership, taxonomy-term resolution — degraded to `optional` and
 * did not actually gate a write. This builds a real `ObjectValidationContext`
 * from the site-objects store so those rules are enforced live.
 *
 * The T0.7 resolvers are SYNCHRONOUS (validation runs synchronously), but the
 * store is async — so this pre-loads every object record once (the site-objects
 * store is small: a handful of pages/navs/sections) and the returned resolvers
 * are sync closures over that in-memory snapshot. One list+get sweep per write;
 * revisit if the store grows large.
 *
 * `isRouteTaken` excludes the object under validation (`selfObjectId`) so a page
 * re-saving its own route is not a false conflict.
 */
import { readArtifactReferenceResult, type ArtifactIndexStore } from './artifact-index.js';
import { MAJOR_KEY_ARTIFACT_REF_RE, PUBLIC_ARTIFACT_PATH_RE, rawArtifactRefForPublicPath } from './artifact-trust.js';
import { collectBlobListItems, mapWithConcurrency, STORE_READ_CONCURRENCY, type BlobListItem } from './blob-list.js';
import { isBlobCredentialsConfigured } from './blob-store.js';
import { loadContentItemIds } from './content-item-index.js';
import type { ArtifactRefResolution, ObjectValidationContext, PageTypeConstraint } from './object-validate.js';
import type { DocumentContentCheck } from './pdf-content-inspection.js';
import { loadPdfContentChecks } from './pdf-content-check-store.js';
import type { ObjectVerbStore } from './object-verbs.js';
import { getPageTypeDefinition } from '../../lib/registry/page-types.js';
import { isRegisteredSectionType } from '../../lib/registry/components/registered-types.js';
import { objectDisplayName } from '../../lib/admin/display-name.js';
import { objectTypes, type ObjectRecord, type ObjectType } from '../../schema/object-record-v1.js';
import type { SectionType } from '../../schema/bodies/section-v1.js';

type SelfRef = {
  selfObjectId?: string;
  selfObjectType?: ObjectType;
  /**
   * The artifact-index blob store. When supplied, every Major-Key artifact ref
   * (raw or /img|/pdf public-path form) discovered in `artifactRefSources` or
   * in any loaded record body is pre-resolved against the index, and the
   * returned context carries a sync `resolveArtifactRef` over that snapshot —
   * so asset refs are checked for EXISTENCE, not just shape. Absent → existence
   * stays unverified (prior behavior).
   */
  artifactIndexStore?: ArtifactIndexStore;
  /**
   * Extra JSON values to sweep for artifact refs (typically the raw request
   * payload, so refs arriving in a create body / patch ops are pre-loaded).
   * Loaded record bodies are always swept in addition.
   */
  artifactRefSources?: unknown[];
  /**
   * T2.5 — a pre-computed snapshot of PDF content-quality checks, keyed by the
   * exact `/pdf/<requestId>/<sha256>.pdf` public path `object-validate.ts`'s
   * `pdf_quality` criterion looks up (`resolvePdfContentCheck` on
   * ObjectValidationContext). This is a PASSTHROUGH, not a fetch: nothing in
   * this function calls out to pdf-tool's `inspect_pdf_artifact` bridge to
   * populate it — that would be exactly the live-network-call-in-a-synchronous-
   * validation-pass this check's own doc refuses to do.
   *
   * W2 review: this OVERRIDE is now the exception, not the only source. When it
   * is absent, the artifact-index sweep below preloads whatever
   * `render_article_pdf` / `verify_pdf_content` last recorded for the PDFs this
   * write is about (`pdf-content-check-store.ts`) — that is what closes ruling
   * D-D. Supply this only to pin a specific verdict (a test, or a caller with a
   * fresher result in hand); it wins over the stored snapshot.
   * Absent, and nothing stored → `resolvePdfContentCheck` is absent → the
   * criterion emits nothing, which is still "not verified", never a pass.
   */
  documentContentChecks?: Record<string, DocumentContentCheck>;
};

// Bounds the per-write index preload; validation resolves at most this many
// distinct artifact refs (any beyond it simply stay "not verified").
const ARTIFACT_REF_PRELOAD_CAP = 200;

const collectArtifactRefCandidates = (sources: unknown[]): Set<string> => {
  const refs = new Set<string>();
  const walk = (value: unknown): void => {
    if (refs.size >= ARTIFACT_REF_PRELOAD_CAP) return;
    if (typeof value === 'string') {
      if (MAJOR_KEY_ARTIFACT_REF_RE.test(value)) refs.add(value);
      else if (PUBLIC_ARTIFACT_PATH_RE.test(value)) refs.add(rawArtifactRefForPublicPath(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (isRecord(value)) {
      for (const child of Object.values(value)) walk(child);
    }
  };
  for (const source of sources) walk(source);
  return refs;
};

/**
 * Pre-resolve the candidate blobKeys against the artifact index (one direct
 * reference-JSON read each — the Major Key embeds its owning requestId and
 * sha). An unreadable index leaves the key unanswered ("cannot verify") rather
 * than reporting it absent; a reference whose stored blobKey differs (e.g. a
 * mistyped extension) reports absent.
 *
 * `strongReads` says whether a miss is TRUSTWORTHY. getArtifactIndexBlobStore
 * asks for `consistency: 'strong'`, but that request is only honoured on the
 * explicit-API path (blobSiteId + blobToken present); on the Lambda
 * name-lookup path it is silently downgraded to eventual — see the W14 T14.4
 * note in blob-store.ts. Under an eventual read a just-written artifact is
 * routinely invisible, so a miss carries no information about existence and
 * MUST leave the key unanswered rather than reporting absent.
 *
 * A read that THROWS is reported separately in `unreadable` rather than being
 * silently swallowed. A thrown read means the index could not be consulted at
 * all — almost always a credential fault — and it is indistinguishable at the
 * call site from "the artifact isn't there", which is precisely how a wrong
 * NETLIFY_BLOBS_TOKEN spent 2026-08-11 masquerading as a passing publish gate.
 * Surfacing it lets the caller say "existence not verified" out loud.
 *
 * Observed live 2026-08-11 without those credentials: an image artifact that
 * had just been created (verified, resolvable by slot through the explicit-API
 * path, and serving fine) read as absent here for 25+ minutes, which blocked
 * the article that referenced it from publishing at all — while a six-day-old
 * artifact on the same site resolved normally. A hit is still conclusive under
 * either consistency, so positive verification is unaffected.
 */
const preloadArtifactRefResolutions = async (
  indexStore: ArtifactIndexStore,
  candidates: Set<string>,
  strongReads: boolean
): Promise<{ resolutions: Map<string, ArtifactRefResolution>; unreadable: string[] }> => {
  const resolutions = new Map<string, ArtifactRefResolution>();
  const unreadable: string[] = [];
  await Promise.all(
    [...candidates].map(async (blobKey) => {
      const [, requestId = '', filename = ''] = blobKey.split('/');
      const sha256 = filename.slice(0, 64).toLowerCase();
      if (!requestId || sha256.length !== 64) {
        resolutions.set(blobKey, { exists: false });
        return;
      }
      try {
        const read = await readArtifactReferenceResult(indexStore, requestId, sha256);
        if (read.status === 'rejected') {
          // The entry EXISTS and platform refused it. That is knowable regardless of
          // read consistency, and it is never fixed by re-uploading — so report it as
          // its own condition rather than laundering it into "never uploaded".
          resolutions.set(blobKey, { exists: false, indexIssue: read.issue });
          return;
        }
        const reference = read.status === 'ok' ? read.reference : undefined;
        if (!reference || reference.blobKey !== blobKey) {
          // Only an absence observed through a strongly-consistent read proves
          // absence. Otherwise leave it unanswered: "cannot verify", not "gone".
          if (strongReads) resolutions.set(blobKey, { exists: false });
          return;
        }
        resolutions.set(blobKey, {
          exists: true,
          ...(reference.deletedAtISO ? { deleted: true } : {}),
          ...(typeof reference.sizeBytes === 'number' ? { sizeBytes: reference.sizeBytes } : {}),
          ...(typeof reference.contentType === 'string' ? { contentType: reference.contentType } : {}),
        });
      } catch {
        // Index unreachable for this key — leave unanswered (not verified), but
        // RECORD it: a thrown read is a fault to report, not an absence to infer.
        unreadable.push(blobKey);
      }
    })
  );
  return { resolutions, unreadable };
};

type TaxonomyTerm = { term_id: string; slug?: string; status?: string; merged_into?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const buildStoreValidationContext = async (
  store: ObjectVerbStore,
  self: SelfRef = {}
): Promise<ObjectValidationContext> => {
  // key: `${objectType}:${objectId}` → record. content_item records live in
  // this store since W7.3 (articles as governed objects); the COMMITTED legacy
  // posts additionally resolve via the content-item index below (trap 4) —
  // both families answer content_item references and share the slug space.
  const records = new Map<string, ObjectRecord>();
  // The 13 per-type listings are independent — issue them together instead of
  // one at a time; then load every listed record with bounded concurrency
  // instead of one `get` at a time. `records` is a Map keyed by
  // `${objectType}:${object_id}`, so load order never affects its contents.
  // A transient failure listing one type degrades to "0 items from that type
  // this sweep" rather than failing validation context-build entirely
  // (2026-08-06 hotfix — matches the per-record resilience below).
  const perTypeItems = await Promise.all(
    objectTypes.map(async (objectType) => {
      // 2026-08-06 hotfix follow-up: chaining `.then()` directly off
      // `store.list()`'s return value throws SYNCHRONOUSLY when that value
      // isn't a real Promise (e.g. a plain AsyncIterable, which is what
      // `{ paginate: true }` can return) — before `.catch()` can ever
      // attach. That made this sweep fail 100% of the time, for every call,
      // regardless of data. Awaiting it first (which works for both a
      // Promise and a plain value) is what makes the try/catch effective.
      try {
        const listResult = await store.list({
          prefix: `objects/${objectType}/by-id/`,
          directories: false,
          paginate: true,
        });
        return { objectType, items: await collectBlobListItems(listResult) };
      } catch (error) {
        console.warn(`buildStoreValidationContext: skipping unlistable object type "${objectType}".`, error);
        return { objectType, items: [] as BlobListItem[] };
      }
    })
  );
  const keyedItems = perTypeItems.flatMap(({ objectType, items }) =>
    items.map((item) => ({ objectType, key: item.key }))
  );
  await mapWithConcurrency(keyedItems, STORE_READ_CONCURRENCY, async ({ objectType, key }) => {
    // 2026-08-06 hotfix: a `store.get` here used to run one-at-a-time; now it
    // runs with real concurrency (STORE_READ_CONCURRENCY), so a single
    // transient Netlify Blobs read failure under that burst load must not
    // abort context-building for every other object — same contract this
    // block already gives a corrupt/unparseable record below.
    let raw: string | null;
    try {
      raw = await store.get(key);
    } catch (error) {
      console.warn(`buildStoreValidationContext: skipping unreadable object record at "${key}".`, error);
      return;
    }
    if (!raw) return;
    try {
      const record = JSON.parse(raw) as ObjectRecord;
      records.set(`${objectType}:${record.object_id}`, record);
    } catch {
      // A corrupt record shouldn't crash validation; treat it as absent.
    }
  });

  // Committed article ids (filenames under src/data/post, via the GitHub
  // contents API — the W3 source of truth). `undefined` when the lookup is
  // unavailable (no GitHub env locally / transient error): the resolver then
  // answers "cannot verify" for content_item refs instead of failing them.
  const contentItemIds = await loadContentItemIds();

  const resolveObject: ObjectValidationContext['resolveObject'] = (objectType, objectId) => {
    if (objectType === 'content_item') {
      // A store record (W7.3 article object) or a committed legacy post id.
      const record = records.get(`content_item:${objectId}`);
      if (record) return { exists: true, published: record.publication?.published_time != null };
      if (contentItemIds?.has(objectId)) return { exists: true };
      return contentItemIds ? { exists: false } : undefined;
    }
    const record = records.get(`${objectType}:${objectId}`);
    if (!record) return { exists: false };
    return { exists: true, published: record.publication?.published_time != null };
  };

  const resolveSharedSectionType: ObjectValidationContext['resolveSharedSectionType'] = (objectId) => {
    const body = records.get(`section:${objectId}`)?.body;
    if (!isRecord(body) || !isRecord(body.section) || typeof body.section.type !== 'string') return undefined;
    return body.section.type as SectionType;
  };

  // D3-sharedref: the resolveSharedSectionType sibling for display names —
  // reuses the SAME preloaded `records` snapshot (no extra store read), and
  // the SAME derivation (`objectDisplayName`) the admin object list already
  // uses to title a shared 'section' object, so the stamped name matches what
  // that object is called everywhere else in the admin. `objectDisplayName`
  // always returns a string (its own "Untitled section" fallback for a
  // nameless target), so a `records` miss (dangling ref — target deleted) is
  // the only `undefined` case here; the write path leaves `sectionName`
  // unset rather than stamping a `null` sentinel (see object-verbs.ts's
  // stampSharedRefSectionNames for why null specifically can't be used).
  const resolveSharedSectionName: ObjectValidationContext['resolveSharedSectionName'] = (objectId) => {
    const record = records.get(`section:${objectId}`);
    return record ? objectDisplayName(record) : undefined;
  };

  // The resolveSharedSectionType sibling for template slot blueprintRefs
  // (W8.2): the blueprint type of a section_template record.
  const resolveSectionTemplateType: ObjectValidationContext['resolveSectionTemplateType'] = (objectId) => {
    const body = records.get(`section_template:${objectId}`)?.body;
    if (!isRecord(body) || !isRecord(body.blueprint) || typeof body.blueprint.type !== 'string') return undefined;
    return body.blueprint.type as SectionType;
  };

  const isRouteTaken: ObjectValidationContext['isRouteTaken'] = (route) => {
    for (const [key, record] of records) {
      if (!key.startsWith('page:')) continue;
      if (record.object_id === self.selfObjectId) continue;
      if (isRecord(record.body) && record.body.route === route) return true;
    }
    return false;
  };

  // The /shop/<slug> analogue of isRouteTaken (06-shop-module-plan §1),
  // scanning product records instead of page routes.
  const isSlugTaken: ObjectValidationContext['isSlugTaken'] = (slug) => {
    for (const [key, record] of records) {
      if (!key.startsWith('product:')) continue;
      if (record.object_id === self.selfObjectId) continue;
      if (isRecord(record.body) && record.body.slug === slug) return true;
    }
    return false;
  };

  // Article slugs share ONE permalink space across content_item objects and
  // the committed legacy posts (their filename stems ARE their slugs). W7.3.
  const isArticleSlugTaken: ObjectValidationContext['isArticleSlugTaken'] = (slug) => {
    for (const [key, record] of records) {
      if (!key.startsWith('content_item:')) continue;
      if (record.object_id === self.selfObjectId) continue;
      if (isRecord(record.body) && record.body.slug === slug) return true;
    }
    return contentItemIds?.has(slug) ?? false;
  };

  // Artifact existence: sweep the request payload + every loaded record body
  // for Major-Key refs (raw or public-path form) and pre-resolve exactly those
  // against the artifact index, so the sync resolver can answer during
  // validation. Any resulting body validation sees derives from these sources.
  let resolveArtifactRef: ObjectValidationContext['resolveArtifactRef'];
  let artifactIndexUnreadable: string[] | undefined;
  // W2 review (ruling D-D, closed): the SAME sweep also names every PDF this
  // write is about, so the last-known content-quality snapshot for each is
  // preloaded here — one `get` per attached PDF (in practice zero or one),
  // beside the reference read already happening for the same key. "Preload
  // once, resolve sync", exactly like `resolveArtifactRef` above; nothing
  // calls pdf-tool, and a missing snapshot stays "not verified".
  let preloadedContentChecks: Record<string, DocumentContentCheck> | undefined;
  if (self.artifactIndexStore) {
    const candidates = collectArtifactRefCandidates([
      ...(self.artifactRefSources ?? []),
      ...[...records.values()].map((record) => record.body),
    ]);
    if (candidates.size > 0) {
      const [preloaded, contentChecks] = await Promise.all([
        preloadArtifactRefResolutions(self.artifactIndexStore, candidates, isBlobCredentialsConfigured()),
        loadPdfContentChecks(
          self.artifactIndexStore,
          [...candidates].filter((ref) => ref.startsWith('pdf/')).map((ref) => `/${ref}`)
        ),
      ]);
      resolveArtifactRef = (blobKey) => preloaded.resolutions.get(blobKey);
      if (preloaded.unreadable.length > 0) artifactIndexUnreadable = preloaded.unreadable;
      if (Object.keys(contentChecks).length > 0) preloadedContentChecks = contentChecks;
    }
  }

  const resolvePageType: ObjectValidationContext['resolvePageType'] = (pageTypeId) => {
    const lookup = getPageTypeDefinition(pageTypeId);
    if (!lookup.ok) return undefined;
    const { id, allowedSections, requiredSections, minVisibleSections } = lookup.definition;
    const constraint: PageTypeConstraint = { id, allowedSections };
    if (requiredSections) constraint.requiredSections = requiredSections;
    if (minVisibleSections !== undefined) constraint.minVisibleSections = minVisibleSections;
    return constraint;
  };

  const componentTypeExists: ObjectValidationContext['componentTypeExists'] = (type) => isRegisteredSectionType(type);

  // Only supply the taxonomy resolver when at least one taxonomy object exists —
  // otherwise every term reference would read as unresolvable (a false positive)
  // rather than "not verified".
  const taxonomyRecords = [...records].filter(([key]) => key.startsWith('taxonomy:')).map(([, record]) => record);
  const resolveTaxonomyTerm: ObjectValidationContext['resolveTaxonomyTerm'] | undefined = taxonomyRecords.length
    ? (kind, termId) => {
        for (const record of taxonomyRecords) {
          const body = record.body;
          const kinds = isRecord(body) && isRecord(body.kinds) ? body.kinds : undefined;
          const kindNode = kinds && isRecord(kinds[kind]) ? (kinds[kind] as Record<string, unknown>) : undefined;
          const terms = (Array.isArray(kindNode?.terms) ? kindNode.terms : []) as TaxonomyTerm[];
          const seen = new Set<string>();
          // Match by term_id OR slug (the shapes cannot collide: ids carry
          // underscores, slugs are hyphen-only) — nav targets pass ids,
          // article taxonomy passes the W3 frontmatter slugs (W7.3).
          let term = terms.find((candidate) => candidate.term_id === termId || candidate.slug === termId);
          // Follow merged_into aliases to the canonical term (D§5.5).
          while (term?.merged_into && !seen.has(term.term_id)) {
            seen.add(term.term_id);
            term = terms.find((candidate) => candidate.term_id === term!.merged_into);
          }
          if (term) return { active: term.status === 'active' };
        }
        return undefined;
      }
    : undefined;

  // A caller-supplied snapshot always wins over the preloaded one (same
  // "caller wins" rule as every other default in this wave); otherwise the
  // store's own snapshots answer.
  const documentContentChecks = self.documentContentChecks ?? preloadedContentChecks;
  const resolvePdfContentCheck: ObjectValidationContext['resolvePdfContentCheck'] = documentContentChecks
    ? (publicPath) => documentContentChecks[publicPath]
    : undefined;

  return {
    resolveObject,
    resolveSharedSectionType,
    resolveSharedSectionName,
    resolveSectionTemplateType,
    isRouteTaken,
    isSlugTaken,
    isArticleSlugTaken,
    resolvePageType,
    componentTypeExists,
    ...(resolveTaxonomyTerm ? { resolveTaxonomyTerm } : {}),
    ...(resolveArtifactRef ? { resolveArtifactRef } : {}),
    ...(artifactIndexUnreadable ? { artifactIndexUnreadable } : {}),
    ...(resolvePdfContentCheck ? { resolvePdfContentCheck } : {}),
  };
};
