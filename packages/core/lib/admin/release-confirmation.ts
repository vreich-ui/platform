/**
 * FIX 5 — what a row may truthfully say before it deploys the whole site.
 *
 * W21.3 put a Release on the finished-but-not-live row and confirmed it with a
 * sentence written from the ROW: it named that article's title and asserted
 * that every pending change would go live "— 'TITLE' among them". Neither half
 * was checked. The row does not know what is waiting, so the dialog was making
 * two claims the data behind it had never been asked about, and the button
 * could fire a forced production build with nothing pending at all.
 *
 * The release surface's own gate is a REVIEW of the waiting batch
 * (`ReleaseWorkspace`: `if (!reviewed || waiting.length === 0) return;`), and
 * a per-row control cannot carry that — an itemised batch review is not a row
 * action, and faking one would be worse than not having it. What a row CAN do
 * is refuse to claim what it has not checked: this module turns the release
 * overview the surface already owns into the two answers the row needs — is
 * there anything to release, and is this row's own object one of the things
 * that would go.
 *
 * Pure, so the copy and the gate are testable where the dialog is not (no DOM
 * harness — `tsconfig.test.json` excludes `admin/**\/*.tsx`).
 */
import type { ReleaseOverview } from './release-client.js';

export interface ReleaseScope {
  /** How many published changes are actually waiting to go live. */
  waitingCount: number;
  /** Whether the row the release was asked FROM is one of them. */
  rowWaiting: boolean;
  /** The row's title, only ever quoted back — never used to imply scope. */
  rowTitle: string;
}

/**
 * The waiting set, derived exactly as `ReleaseWorkspace` derives it
 * (`objects.filter((object) => object.state === 'published')`) so the row and
 * the release surface can never disagree about what a release would send.
 */
export const releaseScopeFrom = (
  overview: ReleaseOverview,
  row: { object_id?: string; title: string }
): ReleaseScope => {
  const waiting = overview.objects.filter((object) => object.state === 'published');
  return {
    waitingCount: waiting.length,
    rowWaiting: Boolean(row.object_id) && waiting.some((object) => object.object_id === row.object_id),
    rowTitle: row.title,
  };
};

export type ReleaseConfirmation =
  /** Nothing is waiting: there is no release to offer, only something to say. */
  | { kind: 'nothing_waiting'; title: string; message: string }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string };

const changes = (count: number): string => `${count} published change${count === 1 ? '' : 's'}`;

/**
 * The dialog, in the three shapes the facts allow.
 *
 * Every sentence is checkable against `scope`: the count is the real waiting
 * count, the row's title appears only as the thing that PROMPTED the release,
 * and "among them" is said only when the row's object really is in the batch.
 * The scope line always names the site, never the article — `admin-release`
 * takes no object id, so a per-article release does not exist to be offered.
 */
export const releaseConfirmation = (scope: ReleaseScope): ReleaseConfirmation => {
  if (scope.waitingCount === 0) {
    return {
      kind: 'nothing_waiting',
      title: 'Nothing is waiting to be released',
      message:
        `No published change is waiting to go live, so a release would send nothing. ` +
        `If “${scope.rowTitle}” still has no live URL, the release that carried it has already run — ` +
        `the Release page shows what production is serving.`,
    };
  }
  const scopeLine =
    `This builds and deploys the whole site: ${changes(scope.waitingCount)} ` +
    `${scope.waitingCount === 1 ? 'is' : 'are'} waiting to go live and a release sends ` +
    `${scope.waitingCount === 1 ? 'it' : 'all of them'} at once.`;
  const rowLine = scope.rowWaiting
    ? `“${scope.rowTitle}” is one of them; it cannot be released on its own.`
    : `“${scope.rowTitle}” is NOT among them — its object is not waiting, so this release would not be what gives it a live URL.`;
  const reviewLine = `The Release page lists them one by one if you want to review the batch first.`;
  return {
    kind: 'confirm',
    title: 'Release the site?',
    message: `${scopeLine} ${rowLine} ${reviewLine}`,
    confirmLabel: 'Release site',
  };
};
