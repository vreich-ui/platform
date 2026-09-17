/**
 * The OAuth BY-SUBJECT index — its key shape, its entry schema, and the store
 * interface both halves share — as a LEAF module.
 *
 * INTEGRATE (wave 2, admin-read-model): `membership/offboarding.ts` revokes a
 * removed person's grants and needs exactly three things from `oauth-store.ts`
 * to do it: `subjectIndexPrefix`, `subjectIndexEntrySchema` and the store type.
 * `oauth-store.ts` is 27 KB of token minting, hashing, rotation and family
 * revocation, none of which offboarding can reach — and `offboarding.ts` is on
 * `admin-users`' cold start (it is a record-write choke-point caller), so the
 * whole of it was loaded before the handler that LISTS PEOPLE ran its first
 * line. This is the `lib/admin/display-name-core.ts` cut of M3.2, applied to
 * the other module that got into that graph the same way.
 *
 * `oauth-store.ts` re-exports every name below, so no existing call site
 * changed; the two spellings mean the same thing and only this one is leaf.
 * Keep it leaf: the `BlobListResponse` import is TYPE-ONLY on purpose, and
 * anything added here is paid for on every admin page load
 * (`tests/netlify/function-bundle-budget.test.ts` is what makes that stick).
 */
import { z } from 'zod';

import type { BlobListResponse } from './blob-list.js';

export const OAUTH_KEY_PREFIX = 'oauth/';

export interface OAuthBlobStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<void | { modified: boolean; etag?: string }>;
  /** Netlify Blobs exposes `delete`; the file-backed dev/test store exposes `del`. Either satisfies this module. */
  delete?(key: string): Promise<void>;
  del?(key: string): Promise<void>;
  /** W18 T18.4: needed only by revocation-by-subject (offboarding); absent on stores that cannot list. */
  /** MUST be consumed through `collectBlobListItems` — see blob-list.ts. */
  list?(options: {
    prefix: string;
    directories?: boolean;
    paginate?: boolean;
  }): BlobListResponse | Promise<BlobListResponse>;
}

/**
 * W18 T18.4 — the by-subject index. Token/refresh/code records are keyed by
 * sha256(value) and carry `subject_email`, but nothing could enumerate "every
 * grant this person holds" — so suspend/remove could not revoke them. Every
 * mint now ALSO writes `oauth/by-subject/<email>/<kind>-<hash>.json` →
 * `{ kind, key }`; `revokeOAuthGrantsForSubject` (membership/offboarding.ts)
 * lists that prefix and deletes both halves. Records minted before this
 * change are not indexed until they rotate (access tokens live 1h, refresh
 * tokens rotate on every use) — documented in plan §5.
 */
export const subjectIndexPrefix = (subjectEmail: string) =>
  `${OAUTH_KEY_PREFIX}by-subject/${subjectEmail.trim().toLowerCase()}/`;
export const subjectIndexKey = (subjectEmail: string, kind: 'token' | 'refresh' | 'code', recordKey: string) =>
  `${subjectIndexPrefix(subjectEmail)}${kind}-${recordKey.split('/').pop()}`;
export const subjectIndexEntrySchema = z.object({ kind: z.enum(['token', 'refresh', 'code']), key: z.string().min(1) });
export type SubjectIndexEntry = z.infer<typeof subjectIndexEntrySchema>;
