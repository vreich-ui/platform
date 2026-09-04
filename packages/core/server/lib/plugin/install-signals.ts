/**
 * Install signals (W7.6) — what the operator can see about an installer,
 * without asking them.
 *
 * THE GAP THIS FILLS. After W7.1 an owner can invite someone and send them an
 * install link in one click. What they could not do is answer, an hour later,
 * the only question that matters: **did it work?** The member list shows
 * "invited"; the plugins page shows a bundle. Neither knows whether the person
 * ever attached a connector, whether it authenticated as them, or whether it
 * is running against a bundle that has since moved. So the owner asks — which
 * is exactly the support loop W7 exists to remove.
 *
 * `whoami` is the signal, and it is a good one precisely because it is not an
 * extra step: the skill calls it at session start and the install page's last
 * step is running it, so a working install produces one by construction. A
 * member with no signal has not finished installing; a member whose signal
 * names an old manifest is running a stale copy.
 *
 * WHAT IS RECORDED, AND WHAT IS NOT. Per member, per surface: the last time a
 * `whoami` arrived, the manifest version and tool digest that call saw, and
 * whether the caller could write. That is the minimum that answers "did it
 * work, on what, and is it current". No arguments, no tool calls, no content —
 * this is an install-status board, not telemetry, and it must never become the
 * place where someone reaches for a usage log.
 *
 * BEST-EFFORT, ALWAYS. Every write here is wrapped by its caller and failure is
 * swallowed. `whoami`'s job is to answer a diagnostic question, and a
 * diagnostic that fails because a status board could not be updated would be a
 * self-defeating joke.
 */
import { z } from 'zod';

import { getPluginManifestBlobStore } from './manifest-store.js';

export const INSTALL_SIGNALS_DOC_KEY = 'install-signals.v1';

export const installSignalSchema = z
  .object({
    /** ISO instant of the most recent whoami from this member on this surface. */
    last_whoami_at: z.string(),
    /** What that call saw — the two numbers that say whether the install is current. */
    manifest_version: z.string().nullable(),
    tools_digest: z.string(),
    /** Whether the caller could write at that moment. `false` is the useful case. */
    can_write: z.boolean(),
    /** Total whoami calls seen, so a one-off probe reads differently from daily use. */
    count: z.number().int().nonnegative(),
  })
  .strict();
export type InstallSignal = z.infer<typeof installSignalSchema>;

export const installSignalsDocSchema = z
  .object({
    schema_version: z.literal('install-signals.v1'),
    /** email → surface → signal. */
    members: z.record(z.string(), z.record(z.string(), installSignalSchema)),
    updated_at: z.string(),
  })
  .strict();
export type InstallSignalsDoc = z.infer<typeof installSignalsDocSchema>;

export const emptyInstallSignalsDoc = (): InstallSignalsDoc => ({
  schema_version: 'install-signals.v1',
  members: {},
  updated_at: new Date(0).toISOString(),
});

export interface InstallSignalsStore {
  get(key: string, options?: { type?: string }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<unknown>;
}

/** A corrupt doc reads as empty: this is a status board, never a source of truth. */
export const getInstallSignalsDoc = async (store: InstallSignalsStore): Promise<InstallSignalsDoc> => {
  let raw: unknown;
  try {
    raw = await store.get(INSTALL_SIGNALS_DOC_KEY, { type: 'json' });
  } catch {
    return emptyInstallSignalsDoc();
  }
  if (raw === null || raw === undefined || raw === '') return emptyInstallSignalsDoc();
  const parsed = installSignalsDocSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyInstallSignalsDoc();
};

/**
 * Bound on how many members the board holds.
 *
 * A tenant has tens of members, not thousands, and this doc is read whole on
 * every plugins-page load. The cap keeps a runaway loop (or a tenant that
 * churns through invitees) from turning a status board into a document nobody
 * can load — oldest signal evicted first, which is also the least interesting.
 */
export const MAX_TRACKED_MEMBERS = 100;

/** Pure: fold one whoami into the doc. */
export const withRecordedWhoami = (
  doc: InstallSignalsDoc,
  input: {
    email: string;
    surface: string;
    manifestVersion: string | null;
    toolsDigest: string;
    canWrite: boolean;
    at: string;
  }
): InstallSignalsDoc => {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.surface) return doc;

  const existing = doc.members[email]?.[input.surface];
  const members: InstallSignalsDoc['members'] = {
    ...doc.members,
    [email]: {
      ...(doc.members[email] ?? {}),
      [input.surface]: {
        last_whoami_at: input.at,
        manifest_version: input.manifestVersion,
        tools_digest: input.toolsDigest,
        can_write: input.canWrite,
        count: (existing?.count ?? 0) + 1,
      },
    },
  };

  const emails = Object.keys(members);
  if (emails.length <= MAX_TRACKED_MEMBERS) return { ...doc, members, updated_at: input.at };

  const newestFirst = emails.sort((a, b) => latestSignalAt(members[b]).localeCompare(latestSignalAt(members[a])));
  return {
    ...doc,
    members: Object.fromEntries(newestFirst.slice(0, MAX_TRACKED_MEMBERS).map((key) => [key, members[key]])),
    updated_at: input.at,
  };
};

/** The most recent whoami across a member's surfaces — the board's sort key. */
export const latestSignalAt = (bySurface: Record<string, InstallSignal>): string =>
  Object.values(bySurface).reduce(
    (latest, signal) => (signal.last_whoami_at > latest ? signal.last_whoami_at : latest),
    ''
  );

/**
 * Record a whoami. Never throws, never blocks the answer it rides on.
 *
 * The read-modify-write is not transactional and does not need to be: the
 * worst case of a lost race is one undercounted `count` on a status board.
 * Paying for a lock here would cost more than the fact is worth.
 */
export const recordWhoamiSignal = async (
  event: unknown,
  input: Parameters<typeof withRecordedWhoami>[1]
): Promise<void> => {
  try {
    const store = (await getPluginManifestBlobStore(event)) as unknown as InstallSignalsStore;
    const doc = await getInstallSignalsDoc(store);
    await store.setJSON(INSTALL_SIGNALS_DOC_KEY, withRecordedWhoami(doc, input));
  } catch {
    // See the header: a status board must never be able to fail a diagnostic.
  }
};
