declare module '@netlify/blobs' {
  type BlobMetadata = Record<string, string>;

  type BlobGetType = 'text' | 'json' | 'arrayBuffer' | 'blob' | 'stream';

  type BlobListResultBlob = { key: string; etag?: string };
  type BlobListResult = { blobs?: BlobListResultBlob[]; directories?: string[] };

  /**
   * P1 (2026-09-18): widened to match the REAL @netlify/blobs>=10.7.13
   * `SetOptions`/`WriteResult`/`GetWithMetadataResult` shapes (this repo's
   * hand-rolled ambient declaration had drifted from the installed package —
   * it never declared `onlyIfNew`/`onlyIfMatch` at all, though the real SDK
   * has supported them since well before this pin). Purely additive: every
   * new field is optional and every widened return type is a superset of
   * what was declared before, so no existing call site's types change.
   */
  type SetConditions = { onlyIfNew?: boolean; onlyIfMatch?: never } | { onlyIfNew?: never; onlyIfMatch?: string };

  type SetOptions = { metadata?: BlobMetadata } & SetConditions;

  /** What the real SDK's `set`/`setJSON` answer — `modified: false` is how a declined CAS reports itself. */
  type WriteResult = { modified: boolean; etag?: string };

  export interface Store {
    get: (key: string, options?: { type?: BlobGetType }) => Promise<unknown>;
    getWithMetadata: (
      key: string,
      options?: { type?: BlobGetType }
    ) => Promise<{ data: unknown; metadata?: BlobMetadata; etag?: string } | null>;
    getMetadata: (key: string) => Promise<{ metadata: BlobMetadata; etag?: string } | null>;
    set: (key: string, value: unknown, options?: SetOptions) => Promise<WriteResult>;
    setJSON: (key: string, value: unknown, options?: SetOptions) => Promise<WriteResult>;
    delete: (key: string) => Promise<void>;
    del: (key: string) => Promise<void>;
    list: (options?: {
      prefix?: string;
      directories?: boolean;
      paginate?: boolean;
      limit?: number;
      cursor?: string;
    }) => Promise<BlobListResult> & AsyncIterable<BlobListResult>;
  }

  type StoreOptions = {
    name: string;
    siteID?: string;
    token?: string;
    apiURL?: string;
    consistency?: 'strong' | 'eventual';
    /** Test-only escape hatch the real SDK exposes; production never sets this. */
    fetch?: typeof fetch;
  };

  type ClientOptions = {
    siteID?: string;
    token?: string;
    apiURL?: string;
  };

  export const connectLambda: (event: unknown) => void;
  export function getStore(name: string): Store;
  export function getStore(options: StoreOptions): Store;
  export function listStores(options?: ClientOptions): Promise<{ stores: string[]; next_cursor?: string }>;
}
