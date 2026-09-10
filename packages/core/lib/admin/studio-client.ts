/**
 * Studio (Templates & Themes) data client — perf follow-up to T9.18.
 *
 * Studio used to hit the network cold on every mount, and each of its three
 * recipe collections (template / section_template / theme) walked its own
 * `list()` then `get()`-per-id loop SERIALLY — a handful of items per type
 * became a dozen-plus sequential round trips before anything could paint,
 * and the whole thing re-ran from scratch every time the route remounted
 * (e.g. switching Studio tabs away and back, or navigating away to an
 * object and back). ContentLibrary (T9.8) already solved exactly this shape
 * of problem for the content browse surface via library-client.ts's cached,
 * de-duped `inventory` fetch — this module gives Studio the same treatment:
 *
 *  - The per-id `get`s for each collection run in PARALLEL, not serially.
 *  - An in-memory, in-flight-de-duped, short-TTL cache: remounting Studio
 *    within the window reuses the last fetch instead of re-running it.
 *  - A `sessionStorage`-persisted copy of the last successful result, so a
 *    repeat visit (switching tabs back) paints immediately instead of the
 *    blocking skeleton, then quietly refreshes in the background.
 *
 * Every mutating verb that changes a recipe's set (instantiate /
 * instantiate_section / apply_theme) already invalidates the content
 * library's inventory cache on success (Studio.tsx's
 * `invalidateLibraryCache()`) — that same call site also invalidates this
 * cache, so a write is never followed by a stale gallery.
 */
import { callObjectVerb, type GetToken } from '../edit-mode/verbs-client.js';
import { getSiteIdentity } from '../site-identity.js';
import { currentPageSignal } from './page-generation.js';
import type { ObjectRecord, ObjectType } from '../../schema/object-record-v1.js';

export type { GetToken };

export type StudioRecord = ObjectRecord<Record<string, unknown>>;

export interface StudioData {
  templates: StudioRecord[];
  sections: StudioRecord[];
  themes: StudioRecord[];
}

/** Cache window: a call within this many ms of the last successful fetch reuses it. */
export const STUDIO_CACHE_TTL_MS = 30_000;

/**
 * How stale a `sessionStorage`-persisted result may be and still be worth
 * painting immediately (a background `force: false` refetch follows right
 * away, so this only needs to guard against genuinely ancient data — e.g. a
 * tab left open for hours — not to match the in-memory TTL exactly).
 */
export const STUDIO_PERSISTED_MAX_AGE_MS = 10 * 60_000;

const STORAGE_KEY = () => `${getSiteIdentity().siteSlug}-studio-cache`;

export interface CachedStudioData {
  data: StudioData;
  fetchedAt: number;
}

let memoryCache: CachedStudioData | null = null;
let inflight: Promise<StudioData> | null = null;

const isRecordArray = (value: unknown): value is StudioRecord[] => Array.isArray(value);

const readSessionCache = (): CachedStudioData | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedStudioData>;
    if (typeof parsed.fetchedAt !== 'number' || !parsed.data || typeof parsed.data !== 'object') return null;
    const data = parsed.data as Partial<StudioData>;
    if (!isRecordArray(data.templates) || !isRecordArray(data.sections) || !isRecordArray(data.themes)) return null;
    return { data: data as StudioData, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
};

const writeSessionCache = (entry: CachedStudioData): void => {
  try {
    sessionStorage.setItem(STORAGE_KEY(), JSON.stringify(entry));
  } catch {
    // Private browsing / disabled storage — the in-memory cache still works
    // for this page's lifetime, which is all this is for.
  }
};

const clearSessionCache = (): void => {
  try {
    sessionStorage.removeItem(STORAGE_KEY());
  } catch {
    // ignored — nothing to clear if storage isn't available
  }
};

/**
 * Synchronous, no-network peek at the last known Studio data — the
 * in-memory cache if this page already fetched, otherwise whatever was
 * persisted to `sessionStorage` by an earlier page/navigation. Callers
 * decide their own staleness tolerance (see `STUDIO_PERSISTED_MAX_AGE_MS`);
 * this never triggers a fetch and never throws.
 */
export function peekCachedStudioData(): CachedStudioData | null {
  if (memoryCache) return memoryCache;
  return readSessionCache();
}

async function loadType(getToken: GetToken, type: ObjectType): Promise<StudioRecord[]> {
  // T1.1: a page-load read (the module doc above is explicit — this is a
  // remount-time-only cache, not a cross-navigation poll like
  // `requests-store.ts`), so it rides the current page-generation signal.
  const signal = currentPageSignal();
  const listed = await callObjectVerb(getToken, { action: 'list', object_type: type }, signal);
  if (listed.status !== 200) {
    throw new Error((listed.body?.error as string) || `Listing ${type} failed (${listed.status}).`);
  }
  const ids = ((listed.body.objects as { object_id: string }[] | undefined) ?? []).map((row) => row.object_id);
  // Parallel, not serial — the N `get`s for one type used to run one at a
  // time (a plain `for` loop with `await` inside), turning a handful of
  // recipes into a handful of sequential round trips before the gallery
  // could paint anything. `Promise.all` collapses that to one round trip's
  // worth of latency regardless of how many recipes exist.
  const results = await Promise.all(
    ids.map((id) => callObjectVerb(getToken, { action: 'get', object_type: type, object_id: id }, signal))
  );
  return results.filter((res) => res.status === 200 && res.body.record).map((res) => res.body.record as StudioRecord);
}

async function requestStudioData(getToken: GetToken): Promise<StudioData> {
  const [templates, sections, themes] = await Promise.all([
    loadType(getToken, 'template'),
    loadType(getToken, 'section_template'),
    loadType(getToken, 'theme'),
  ]);
  return { templates, sections, themes };
}

/** Always issues a fresh request, updates both caches, and tracks it as the shared in-flight promise. */
function runFetch(getToken: GetToken): Promise<StudioData> {
  const thisFetch = requestStudioData(getToken).then((data) => {
    const entry: CachedStudioData = { data, fetchedAt: Date.now() };
    memoryCache = entry;
    writeSessionCache(entry);
    return data;
  });
  inflight = thisFetch;
  // Clear the in-flight marker once this fetch settles, without creating a
  // second unhandled-rejection path — the caller-facing `thisFetch` promise
  // (returned below) still carries the real rejection for whoever awaits it.
  thisFetch.then(
    () => {
      if (inflight === thisFetch) inflight = null;
    },
    () => {
      if (inflight === thisFetch) inflight = null;
    }
  );
  return thisFetch;
}

export async function fetchStudioData(getToken: GetToken, opts?: { force?: boolean }): Promise<StudioData> {
  const force = opts?.force ?? false;

  if (!force) {
    if (memoryCache && Date.now() - memoryCache.fetchedAt < STUDIO_CACHE_TTL_MS) {
      return memoryCache.data;
    }
    if (inflight) return inflight;
  }

  return runFetch(getToken);
}

/** Clears the in-memory cache and any in-flight promise reference so the next call is forced to hit the network. */
export function invalidateStudioCache(): void {
  memoryCache = null;
  inflight = null;
  clearSessionCache();
}
