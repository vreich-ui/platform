/**
 * Git Data API committer for object derived exports (T1.2).
 *
 * Commits T1.1-materialized files to the content repo: head ref → base
 * commit → blobs → tree → commit → PATCH ref with force:false — the same
 * conceptual flow as the article publisher (publish-article.ts:1783-1835,
 * A§1.6), implemented INDEPENDENTLY. Zero import edges to or from the
 * article side, in either direction, so a change to one publish path can
 * never silently break the other; the ~60-line duplication is the recorded
 * OQ-12 tradeoff (05-task-breakdown §3), not something to dedupe away.
 *
 * What this has that the article path deliberately lacks (OQ-13): once
 * object publishing is live, this committer and publish-article form two
 * independent commit streams racing to PATCH refs/heads/{branch}. On a
 * non-fast-forward rejection this module re-fetches head, rebuilds the tree
 * against the new base, and retries with backoff up to maxAttempts;
 * exhaustion throws a loud ObjectGitCommitError — never a silent drop,
 * never an unbounded loop. The article side keeps its single un-retried
 * PATCH; adding retry there is a parked decision (OQ-13), not this module's
 * problem.
 *
 * Idempotence under retry leans on T1.1's determinism: unchanged content
 * produces identical bytes, so blobs/trees are content-addressed to the
 * same shas, and a rebuilt tree equal to the new head's tree (the content
 * already landed — e.g. a prior attempt's PATCH succeeded but its response
 * was lost) short-circuits to a no-op result instead of minting an empty
 * duplicate commit.
 *
 * Env contract identical to the article publisher: GITHUB_CONTENT_TOKEN,
 * GITHUB_REPOSITORY, GITHUB_BRANCH (?? BRANCH ?? 'main'),
 * GITHUB_COMMIT_AUTHOR_NAME/EMAIL.
 */
import { getSiteIdentity } from '../../lib/site-identity.js';
import type { MaterializedFile } from './materialize.js';
import { PLATFORM_ENV_NAMES, readBoundEnv, type SiteBindingEnvNames } from './site-binding.js';

const GITHUB_API_ROOT = 'https://api.github.com';
const USER_AGENT = `${getSiteIdentity().siteSlug}-object-publisher`;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BACKOFF_BASE_MS = 250;

type GitHubRef = { object: { sha: string } };
type GitHubCommit = { tree: { sha: string } };
type GitHubBlob = { sha: string };
type GitHubTree = { sha: string };

export type ObjectGitCommitErrorCode =
  | 'not_configured'
  | 'invalid_input'
  | 'github_api_error'
  | 'non_fast_forward_exhausted';

export class ObjectGitCommitError extends Error {
  statusCode: number;
  code: ObjectGitCommitErrorCode;
  /** Raw GitHub response status/body, kept for retry classification and diagnostics. */
  githubStatus?: number;
  githubBody?: string;

  constructor(
    code: ObjectGitCommitErrorCode,
    statusCode: number,
    message: string,
    github?: { status: number; body: string }
  ) {
    super(message);
    this.name = 'ObjectGitCommitError';
    this.code = code;
    this.statusCode = statusCode;
    this.githubStatus = github?.status;
    this.githubBody = github?.body;
  }
}

export type CommitMaterializedFilesInput = {
  files: MaterializedFile[];
  /**
   * Repo-relative paths to DELETE in the same commit (W14 F6). A retire removes
   * an object's export so the page stops building — without this the record can
   * be archived while its export keeps rendering, which inverts the reader-safe
   * direction (the exact reason unpublish was deferred in object-publish.ts).
   * Deletion rides GitHub's tree API: an entry with `sha: null` against
   * `base_tree` removes the path. Deleting a path that is already absent is a
   * no-op for the resulting tree, so a retried retire converges.
   */
  deletions?: string[];
  message: string;
  /** Total attempts at the tree→commit→ref sequence, including the first. */
  maxAttempts?: number;
  /** Backoff before retry N (1-based). Default: 250ms · 2^(N−1). */
  backoffMs?: (attempt: number) => number;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a setTimeout-based delay. */
  sleep?: (ms: number) => Promise<void>;
};

export type CommitMaterializedFilesResult = {
  branch: string;
  /** The commit now containing the exports: the new commit, or head when noOp. */
  commitSha: string;
  treeSha: string;
  /** True when head already contained exactly this content — nothing committed. */
  noOp: boolean;
  attempts: number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultBackoffMs = (attempt: number) => DEFAULT_BACKOFF_BASE_MS * 2 ** (attempt - 1);

/**
 * T16.5: the single predicate for "is the object git committer configured" —
 * both the real call path (resolveGitHubConfig below) and
 * capability-status.ts's `git_committer` family read this same function, so
 * there is exactly one place the required env names live. GITHUB_BRANCH is
 * deliberately excluded: it defaults to 'main' and never gates configured/
 * not-configured (T11.7 census).
 */
export const gitCommitterMissingEnvVars = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES): string[] => {
  const token = readBoundEnv(envNames.gitContentToken);
  const repo = readBoundEnv(envNames.gitRepository);
  return [...(token ? [] : ['GITHUB_CONTENT_TOKEN']), ...(repo ? [] : ['GITHUB_REPOSITORY'])];
};

export const isGitCommitterConfigured = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES): boolean =>
  gitCommitterMissingEnvVars(envNames).length === 0;

const resolveGitHubConfig = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES) => {
  const token = readBoundEnv(envNames.gitContentToken);
  const repo = readBoundEnv(envNames.gitRepository);
  const branch = readBoundEnv(envNames.gitBranch) ?? 'main';

  if (!token || !repo) {
    throw new ObjectGitCommitError(
      'not_configured',
      500,
      'Object publishing is not configured. Set GITHUB_CONTENT_TOKEN and GITHUB_REPOSITORY in Netlify.'
    );
  }

  return { token, repo, branch };
};

const resolveAuthor = () => {
  // W11 T11.5: fallback author from the site identity seam (env overrides win,
  // as before). Byte-identical for Dr-Lurie via its committed site config.
  const identity = getSiteIdentity();
  return {
    name: process.env.GITHUB_COMMIT_AUTHOR_NAME ?? identity.committerName,
    email: process.env.GITHUB_COMMIT_AUTHOR_EMAIL ?? identity.committerEmail,
  };
};

const githubRequest = async <T>(
  fetchImpl: typeof fetch,
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> => {
  const response = await fetchImpl(`${GITHUB_API_ROOT}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ObjectGitCommitError(
      'github_api_error',
      response.status === 401 || response.status === 403 ? 403 : 500,
      `GitHub API ${response.status} for ${path}: ${body}`,
      { status: response.status, body }
    );
  }

  return (await response.json()) as T;
};

// GitHub rejects a force:false ref update that would lose history with
// 422 "Update is not a fast forward"; 409 is accepted defensively.
const isNonFastForwardRejection = (error: unknown): error is ObjectGitCommitError => {
  if (!(error instanceof ObjectGitCommitError) || error.code !== 'github_api_error') return false;
  if (error.githubStatus === 409) return true;
  return error.githubStatus === 422 && /fast[\s-]?forward/i.test(error.githubBody ?? '');
};

/**
 * Commit materialized derived exports to the content branch. Retries the
 * tree→commit→ref sequence against a re-fetched head on non-fast-forward
 * rejection; any other failure propagates immediately.
 */
export const commitMaterializedFiles = async (
  input: CommitMaterializedFilesInput
): Promise<CommitMaterializedFilesResult> => {
  const { files, message } = input;
  const deletions = input.deletions ?? [];

  // A commit must DO something: writes, deletions, or both. A retire commit
  // carries deletions and no files, which is legitimate.
  if (!files.length && !deletions.length) {
    throw new ObjectGitCommitError('invalid_input', 400, 'No materialized files to commit.');
  }
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length) {
    throw new ObjectGitCommitError('invalid_input', 400, 'Materialized files contain duplicate paths.');
  }
  const deletionPaths = new Set(deletions);
  if (deletionPaths.size !== deletions.length) {
    throw new ObjectGitCommitError('invalid_input', 400, 'Deletions contain duplicate paths.');
  }
  // Writing and deleting the same path in one commit is a caller bug — the
  // outcome would depend on tree-entry order rather than intent.
  const conflict = deletions.find((path) => paths.has(path));
  if (conflict) {
    throw new ObjectGitCommitError('invalid_input', 400, `Path is both written and deleted: ${conflict}`);
  }
  if (!message.trim()) {
    throw new ObjectGitCommitError('invalid_input', 400, 'A commit message is required.');
  }

  const { token, repo, branch } = resolveGitHubConfig();
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const sleep = input.sleep ?? defaultSleep;
  const backoffMs = input.backoffMs ?? defaultBackoffMs;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const author = resolveAuthor();

  // Blobs are content-addressed and independent of the base commit — created
  // once; only the tree→commit→ref sequence re-runs on a ref race.
  const blobs = await Promise.all(
    files.map((file) =>
      githubRequest<GitHubBlob>(fetchImpl, `/repos/${repo}/git/blobs`, token, {
        method: 'POST',
        body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
      })
    )
  );
  const treeEntries = [
    ...files.map((file, index) => ({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blobs[index].sha,
    })),
    // `sha: null` against base_tree removes the path (GitHub Git Trees API).
    ...deletions.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
  ];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ref = await githubRequest<GitHubRef>(
      fetchImpl,
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      token
    );
    const headSha = ref.object.sha;
    const baseCommit = await githubRequest<GitHubCommit>(fetchImpl, `/repos/${repo}/git/commits/${headSha}`, token);
    const tree = await githubRequest<GitHubTree>(fetchImpl, `/repos/${repo}/git/trees`, token, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeEntries }),
    });

    // Head already carries exactly this content (T1.1 determinism makes this
    // comparison meaningful) — committing would mint an empty duplicate.
    if (tree.sha === baseCommit.tree.sha) {
      return { branch, commitSha: headSha, treeSha: tree.sha, noOp: true, attempts: attempt };
    }

    const newCommit = await githubRequest<{ sha: string }>(fetchImpl, `/repos/${repo}/git/commits`, token, {
      method: 'POST',
      body: JSON.stringify({ author, committer: author, message, parents: [headSha], tree: tree.sha }),
    });

    try {
      await githubRequest(fetchImpl, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ force: false, sha: newCommit.sha }),
      });
      return { branch, commitSha: newCommit.sha, treeSha: tree.sha, noOp: false, attempts: attempt };
    } catch (error) {
      if (!isNonFastForwardRejection(error)) throw error;
      if (attempt === maxAttempts) {
        throw new ObjectGitCommitError(
          'non_fast_forward_exhausted',
          409,
          `Ref update for refs/heads/${branch} was rejected as non-fast-forward ${maxAttempts} time(s) — ` +
            `a concurrent commit stream (OQ-13) kept winning the race. Giving up after ${maxAttempts} attempts; ` +
            'the exports were NOT committed and the publish must be retried.',
          error.githubStatus !== undefined ? { status: error.githubStatus, body: error.githubBody ?? '' } : undefined
        );
      }
      await sleep(backoffMs(attempt));
    }
  }

  // Unreachable: every loop iteration returns or throws.
  throw new ObjectGitCommitError('non_fast_forward_exhausted', 409, 'Ref update retry loop exited unexpectedly.');
};
