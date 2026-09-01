/**
 * The publish/release tail as the run card says it — pure, so the copy is
 * testable outside the component (`RequestActivity.tsx` renders this).
 *
 * The state comes from the executors' own evidence (`publication` on the
 * activity view, `server/lib/requests/publication-evidence.ts`); this module
 * only decides the words and the link. It never infers a state of its own.
 */
import type { ActivityView } from './requests-client.js';
import type { AdminSeverity } from './severity.js';

export type PublicationView = NonNullable<ActivityView['publication']>;

export interface PublicationCopy {
  severity: AdminSeverity;
  title: string;
  /** One sentence under the title; absent when the title says it all. */
  detail?: string;
  /** Machine facts worth a glance: deploy id, commit. */
  facts: string[];
  /** Whether the card should offer "Check again" — only while go-live is unconfirmed. */
  offerRecheck: boolean;
}

const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * The article's live URL: `article_path` joined to the site origin. The admin
 * surface is served BY the site (each tenant is its own Netlify project), so
 * the page's own origin is the site's — no configuration to read.
 */
/**
 * FIX 5 — whether that URL may be rendered as a LINK.
 *
 * Only `state: 'live'` means the release confirmed production serves the
 * article. `published_pending_release` means the export is committed with
 * `[skip netlify]` and the deploy has not run, so the same path is a 404 —
 * the card still SHOWS it (it is where the article will be, and the operator
 * needs to read it), but as text with the reason, never as something to
 * click. Same rule the row's `NO_LIVE_PATH` states for the inbox.
 */
export const liveUrlIsLinkable = (publication: PublicationView): boolean => publication.state === 'live';

/** Why the URL above is not a link yet. */
export const UNCONFIRMED_LIVE_URL_REASON =
  'Not linked yet — the release has not confirmed production is serving this URL.';

export const liveArticleUrl = (articlePath: string | undefined, origin: string | undefined): string | undefined => {
  if (!articlePath) return undefined;
  const path = articlePath.startsWith('/') ? articlePath : `/${articlePath}`;
  if (!origin) return path;
  return `${origin.replace(/\/+$/, '')}${path}`;
};

export const publicationCopy = (publication: PublicationView): PublicationCopy => {
  const facts: string[] = [];
  if (publication.deploy_id) facts.push(`deploy ${publication.deploy_id}`);
  if (publication.commit) facts.push(`commit ${shortSha(publication.commit)}`);

  if (publication.state === 'live') {
    return {
      severity: 'success',
      title: 'Live',
      detail: publication.article_path
        ? undefined
        : 'Production confirmed serving this article. The live path was not in the publish receipt.',
      facts,
      offerRecheck: false,
    };
  }
  return {
    severity: 'needs_you',
    title: 'Published — awaiting release confirmation',
    detail: publication.release_blockers?.[0]
      ? publication.release_blockers[0]
      : publication.release_reason
        ? `The release did not confirm go-live (${publication.release_reason.replace(/_/g, ' ')}).`
        : 'The article is committed and published; the production release has not confirmed go-live yet.',
    facts,
    offerRecheck: true,
  };
};

/** "Proceeded autonomously — publishing" — the one line an advisory record earns. */
export const policyRecordLine = (record: { node_id: string }, label: string | undefined): string =>
  `Proceeded autonomously — ${label ?? record.node_id}`;
