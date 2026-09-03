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

// Matches blob-store.ts's BlobSetOptions (metadata + onlyIfNew) — some consumers (e.g.
// order-reissue.ts) declare their own narrower local `Store` type expecting `onlyIfNew` on
// set/setJSON options, so this shape has to be a superset of every such option bag rather
// than just the fields the local fallback itself acts on. `onlyIfNew` is accepted but not
// enforced here (this fallback exists for local dev/tests, not production correctness).
export type LocalBlobSetOptions = { metadata?: LocalBlobMetadata; onlyIfNew?: boolean };

export type LocalBlobStore = {
  set: (key: string, value: LocalBlobValue, options?: LocalBlobSetOptions) => Promise<void>;
  get: (key: string) => Promise<string | null>;
  // Mirrors @netlify/blobs' Store.getWithMetadata (netlify-blobs.d.ts) closely enough for the
  // production code paths that call it to work unchanged against the local fallback.
  // Optional so the many pre-existing hand-rolled fake stores in tests (which predate this
  // method and only implement get/set/setJSON/del/list) keep satisfying this type.
  getWithMetadata?: (
    key: string,
    options?: { type?: 'arrayBuffer' | 'buffer' | 'text' }
  ) => Promise<{ data: unknown; metadata?: LocalBlobMetadata } | null>;
  del: (key: string) => Promise<void>;
  setJSON: (key: string, value: unknown, options?: LocalBlobSetOptions) => Promise<void>;
  list: (options?: {
    prefix?: string;
    directories?: boolean;
  }) => Promise<{ blobs: Array<{ key: string; etag: string }>; directories: string[] }>;
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

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, typeof value === 'string' ? value : new Uint8Array(value));
      await writeMetadata(key, options?.metadata);
    },

    get: getBlob as LocalBlobStore['get'],

    async getWithMetadata(key, options) {
      const data = await getBlob(key, options);
      if (data === null) return null;

      return { data, metadata: await readMetadata(key) };
    },

    async del(key) {
      await rm(toPath(storeName, key), { force: true });
      await rm(toMetaPath(storeName, key), { force: true });
    },

    async setJSON(key, value, options) {
      await this.set(key, JSON.stringify(value, null, 2), options);
    },

    async list(options) {
      const prefix = options?.prefix ?? '';
      const files = await listFiles(join(storeRoot, prefix));

      return {
        blobs: files.map((filePath) => ({ key: toBlobKey(storeRoot, filePath), etag: '' })),
        directories: [],
      };
    },
  };
};
