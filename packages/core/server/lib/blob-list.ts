/**
 * `key` is all `@netlify/blobs` used to be modelled as returning here, but its
 * real `ListResultBlob` is `{ key, etag }` — the etag comes back with the
 * listing at NO extra cost, and T5.1 R3 uses it to decide, per key, whether a
 * cached projection of that blob is still valid without reading the blob.
 *
 * Optional on purpose. The local file-backed store (`local-blobs.ts`) reports
 * `etag: ''`, and a caller must treat an empty or absent etag as
 * "unverifiable" — NEVER as "two blobs with no etag match" — so those paths
 * degrade to reading the record, which is exactly the old behaviour.
 */
export type BlobListItem = { key: string; etag?: string };

export type BlobListResult = {
  blobs?: BlobListItem[];
  files?: BlobListItem[];
  directories?: string[];
};

export type BlobListResponse = BlobListResult | AsyncIterable<BlobListResult>;

const isObject = (value: unknown): value is Record<PropertyKey, unknown> => Boolean(value && typeof value === 'object');

export const isAsyncBlobListResponse = (value: BlobListResponse): value is AsyncIterable<BlobListResult> => {
  return (
    isObject(value) && typeof (value as Partial<AsyncIterable<BlobListResult>>)[Symbol.asyncIterator] === 'function'
  );
};

export const getBlobListItems = (page: BlobListResult): BlobListItem[] => page.blobs ?? page.files ?? [];

export const collectBlobListItems = async (result: BlobListResponse): Promise<BlobListItem[]> => {
  const items: BlobListItem[] = [];

  if (isAsyncBlobListResponse(result)) {
    for await (const page of result) {
      items.push(...getBlobListItems(page));
    }
  } else {
    items.push(...getBlobListItems(result));
  }

  return items;
};

/**
 * Bounds how many blob `get`s (or `list`s) run concurrently against the
 * store. High enough to collapse a serial ~70-record sweep into a handful of
 * parallel batches, low enough not to hammer the underlying blob API.
 */
// Lowered from 16 (2026-08-06 hotfix): a burst of 16 concurrent Netlify Blobs
// reads against a single site-objects store — hit on every /admin/content
// load once the reads stopped being serial — was tripping transient
// get()/list() failures in production (a single rejected read, previously an
// even-rarer event spread across a slow serial sweep, now aborted the WHOLE
// inventory/audit/validation sweep — see the resilience fix in the callers
// below for the other half of this). 8 keeps most of the parallelism win
// while roughly halving how many blob requests are in flight against the
// store at once.
export const STORE_READ_CONCURRENCY = 8;

/**
 * Map `items` through `fn` with at most `limit` in flight at once, preserving
 * INPUT ORDER in the returned array regardless of which items resolve first —
 * callers that depend on positional output (e.g. zipping results back against
 * their source items) can rely on `result[i]` corresponding to `items[i]`.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};
