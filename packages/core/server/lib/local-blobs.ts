import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

let localBlobsRootForTesting: string | undefined;

// Test-only override so concurrently-run test files (each isolated by node:test into
// its own process, but sharing the repo's working directory) don't race on the same
// on-disk fallback store — mirrors setNetlifyBlobsModuleForTesting in blob-store.ts.
export const setLocalBlobsRootForTesting = (root?: string) => {
  localBlobsRootForTesting = root;
};

/**
 * Under `node --test` each test FILE gets its own process but they all share the
 * repo's working directory, so every file that does not call
 * `setLocalBlobsRootForTesting` lands on the same on-disk store and concurrent
 * files clobber each other's keys. That surfaced as a genuinely flaky suite —
 * a different artifact test failed on each run with "expected N bytes/<sha>,
 * stored N bytes/<other sha>" (same size, different content: another file's
 * write at the same key). Scoping the DEFAULT root by pid isolates them
 * automatically, so a test file no longer has to remember.
 *
 * Test-context only: `netlify dev` and any other local run keeps the stable
 * path, or its blobs would vanish on every restart. Production never reaches
 * here at all — the lambda guard in blob-store.ts fails closed first.
 */
const isTestRun = process.env.NODE_TEST_CONTEXT !== undefined;

const getLocalBlobsRoot = () =>
  localBlobsRootForTesting ?? join(process.cwd(), '.netlify', isTestRun ? `local-blobs-${process.pid}` : 'local-blobs');

// Metadata sidecars live in a wholly separate tree from the blob bytes so they
// never show up as spurious keys in list() (which walks the blob tree
// recursively). Mirrors getLocalBlobsRoot's pid-scoping for test isolation.
const getLocalBlobsMetaRoot = () =>
  localBlobsRootForTesting
    ? `${localBlobsRootForTesting}-meta`
    : join(process.cwd(), '.netlify', isTestRun ? `local-blobs-meta-${process.pid}` : 'local-blobs-meta');

const toPath = (storeName: string, key: string) => join(getLocalBlobsRoot(), storeName, key);

const toMetaPath = (storeName: string, key: string) => join(getLocalBlobsMetaRoot(), storeName, `${key}.json`);

const toBlobKey = (storeRoot: string, filePath: string) => relative(storeRoot, filePath).split(sep).join('/');

export type LocalBlobValue = string | Buffer | Uint8Array | ArrayBuffer;

export type LocalBlobMetadata = Record<string, string>;

// Matches blob-store.ts's BlobSetOptions (metadata + onlyIfNew/onlyIfMatch).
//
// P1 (2026-09-18): before this pin, `onlyIfNew` was accepted but not
// enforced and `onlyIfMatch` did not exist — every test/dev run against
// this shim got NO concurrency protection, silently. Both are now honoured:
// a real content-hash etag is computed on every read AND write (never
// persisted, so an existing on-disk blob is already correct — no
// migration), and `set`/`setJSON` refuse a failed condition exactly as
// `@netlify/blobs` does (`{modified:false}`, no write).
export type LocalBlobSetOptions = { metadata?: LocalBlobMetadata; onlyIfNew?: boolean; onlyIfMatch?: string };

/** What a conditional (or unconditional) write answers — mirrors the real SDK's `WriteResult`. */
export type LocalBlobWriteResult = { modified: boolean; etag?: string };

export type LocalBlobStore = {
  set: (key: string, value: LocalBlobValue, options?: LocalBlobSetOptions) => Promise<LocalBlobWriteResult>;
  get: (key: string) => Promise<string | null>;
  // Mirrors @netlify/blobs' Store.getWithMetadata (netlify-blobs.d.ts) closely enough for the
  // production code paths that call it to work unchanged against the local fallback.
  // Optional so the many pre-existing hand-rolled fake stores in tests (which predate this
  // method and only implement get/set/setJSON/del/list) keep satisfying this type.
  getWithMetadata?: (
    key: string,
    options?: { type?: 'arrayBuffer' | 'buffer' | 'text' }
  ) => Promise<{ data: unknown; metadata?: LocalBlobMetadata; etag?: string } | null>;
  del: (key: string) => Promise<void>;
  setJSON: (key: string, value: unknown, options?: LocalBlobSetOptions) => Promise<LocalBlobWriteResult>;
  list: (options?: {
    prefix?: string;
    directories?: boolean;
  }) => Promise<{ blobs: Array<{ key: string; etag: string }>; directories: string[] }>;
};

/** The etag: a content hash computed fresh from what is on disk now, never stored — so an existing blob already has a valid one, no backfill needed. */
const computeEtag = (bytes: Buffer | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const toBytes = (value: LocalBlobValue): Uint8Array =>
  typeof value === 'string' ? Buffer.from(value, 'utf8') : new Uint8Array(value);

const readRawBytes = async (storeName: string, key: string): Promise<Buffer | undefined> => {
  try {
    return await readFile(toPath(storeName, key));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};

const listFiles = async (current: string): Promise<string[]> => {
  try {
    const entries = await readdir(current, { withFileTypes: true });
    const files = await Promise.all(
      entries.map((entry) => {
        const entryPath = join(current, entry.name);

        return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
      })
    );

    return files.flat();
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return [];
    }

    throw error;
  }
};

export const createLocalBlobStore = (storeName: string): LocalBlobStore => {
  const storeRoot = join(getLocalBlobsRoot(), storeName);
  const getBlob = async (key: string, options?: { type?: 'arrayBuffer' | 'buffer' | 'text' | 'json' }) => {
    try {
      if (options?.type === 'buffer') {
        return await readFile(toPath(storeName, key));
      }

      /**
       * `type: 'json'` is part of the Netlify Blobs `get` contract and this
       * shim did not implement it — the option fell through to the text branch
       * and callers got a STRING where production hands them a parsed object.
       * Silent, because the callers that use it are defensive: the plugin
       * manifest store's reader safe-parses and falls back to an empty doc, so
       * offline every read of a stored manifest looked like "nothing has ever
       * been rendered". A render followed by a promote could not be proven
       * anywhere but production.
       *
       * Parse failure returns null (the key exists but is not JSON) rather
       * than throwing, matching how the real client refuses to hand back a
       * half-value.
       */
      if (options?.type === 'json') {
        const text = await readFile(toPath(storeName, key), 'utf8');
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return null;
        }
      }

      if (options?.type === 'arrayBuffer') {
        const bytes = await readFile(toPath(storeName, key));

        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }

      return await readFile(toPath(storeName, key), 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  };

  const readMetadata = async (key: string): Promise<LocalBlobMetadata | undefined> => {
    try {
      return JSON.parse(await readFile(toMetaPath(storeName, key), 'utf8')) as LocalBlobMetadata;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;

      throw error;
    }
  };

  const writeMetadata = async (key: string, metadata: LocalBlobMetadata | undefined) => {
    const metaPath = toMetaPath(storeName, key);

    if (!metadata) {
      await rm(metaPath, { force: true });
      return;
    }

    await mkdir(dirname(metaPath), { recursive: true });
    await writeFile(metaPath, JSON.stringify(metadata));
  };

  return {
    async set(key, value, options) {
      const filePath = toPath(storeName, key);
      const bytes = toBytes(value);

      // P1: the condition is checked against whatever is on disk RIGHT NOW,
      // immediately before the write — as close to atomic as a single
      // process can make a check-then-write, which is what this shim is for
      // (single-process local dev and sequential test execution, never a
      // stand-in for the real backend's server-side atomicity).
      if (options?.onlyIfNew || options?.onlyIfMatch !== undefined) {
        const current = await readRawBytes(storeName, key);
        if (options.onlyIfNew && current !== undefined) return { modified: false };
        if (options.onlyIfMatch !== undefined) {
          if (current === undefined || computeEtag(current) !== options.onlyIfMatch) return { modified: false };
        }
      }

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes);
      await writeMetadata(key, options?.metadata);
      return { modified: true, etag: computeEtag(bytes) };
    },

    get: getBlob as LocalBlobStore['get'],

    async getWithMetadata(key, options) {
      const [data, raw] = await Promise.all([getBlob(key, options), readRawBytes(storeName, key)]);
      if (data === null || raw === undefined) return null;

      return { data, metadata: await readMetadata(key), etag: computeEtag(raw) };
    },

    async del(key) {
      await rm(toPath(storeName, key), { force: true });
      await rm(toMetaPath(storeName, key), { force: true });
    },

    async setJSON(key, value, options) {
      return this.set(key, JSON.stringify(value, null, 2), options);
    },

    async list(options) {
      const prefix = options?.prefix ?? '';
      const files = await listFiles(join(storeRoot, prefix));

      const blobs = await Promise.all(
        files.map(async (filePath) => {
          const key = toBlobKey(storeRoot, filePath);
          // P1: a real etag, computed the same way `set`/`getWithMetadata` do,
          // so a row cached against one agrees with the other — `index-store.ts`'s
          // verified-row reuse compares a cached entry's etag against what a
          // fresh `list()` reports, and that comparison is meaningless if this
          // shim answers a constant `''` for every key, as it did before P1.
          let etag = '';
          try {
            etag = computeEtag(await readFile(filePath));
          } catch {
            // Read lost a race with a concurrent delete/write in this same
            // process; the listing still names the key, with an etag no
            // verified-row check can match — the same safe "never trust"
            // shape an unreadable blob gets in production.
          }
          return { key, etag };
        })
      );

      return { blobs, directories: [] };
    },
  };
};
