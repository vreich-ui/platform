import { readBoundEnv, type SiteBinding } from '../lib/site-binding.js';
import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { getHeader } from '../lib/admin-auth.js';
import {
  getDeployReceiptByCommit,
  getDeployReceiptByDeployId,
  getPublishedProductionDeploy,
  isNetlifyDeployLookupConfigured,
  type DeployReceipt,
} from '../lib/netlify-deploys.js';
import { isCommitAncestorOrEqual } from '../lib/production-release.js';

type LambdaEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
};

type QueuedDeployReceipt = Partial<Omit<DeployReceipt, 'deployStatus'>> & {
  deployStatus: 'queued';
};

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const requestSchema = z
  .object({
    commit: z.string().trim().min(1).optional(),
    deployId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.commit || value.deployId), {
    message: 'At least one of commit or deployId is required.',
    path: ['commit'],
  });

const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  statusCode: status,
  headers: jsonHeaders,
  body: JSON.stringify({ ok: status >= 200 && status < 300, status, ...body }),
});

const safeJsonParse = (event: LambdaEvent) => {
  if (!event.body) return { ok: false as const };

  try {
    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

    return { ok: true as const, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false as const };
  }
};

const secretsMatch = (provided: string, expected: string) => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

const verifyPublishKey = (event: LambdaEvent, binding: SiteBinding) => {
  const provided = getHeader(event.headers, 'x-publish-key').trim();
  const expected = readBoundEnv(binding.env.publishSecret) ?? '';

  if (!provided || !expected || !secretsMatch(provided, expected)) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  return undefined;
};

const getQueuedReceipt = ({
  commit,
  deployId,
  errorMessage,
}: {
  commit?: string;
  deployId?: string;
  errorMessage?: string;
}): QueuedDeployReceipt => ({
  ...(commit ? { commit } : {}),
  ...(deployId ? { deployId } : {}),
  deployStatus: 'queued',
  ...(errorMessage ? { errorMessage } : {}),
});

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const contentType = getHeader(event.headers, 'content-type').toLowerCase();
  if (!contentType.includes('application/json')) {
    return jsonResponse(415, { error: 'Content-Type must be application/json.' });
  }

  const authFailure = verifyPublishKey(event, binding);
  if (authFailure) return authFailure;

  const parsedJson = safeJsonParse(event);
  if (!parsedJson.ok) return jsonResponse(400, { error: 'Invalid request body.' });

  const parsedBody = requestSchema.safeParse(parsedJson.value);
  if (!parsedBody.success) {
    return jsonResponse(400, { error: 'Invalid request fields.', issues: parsedBody.error.issues });
  }

  const { commit, deployId } = parsedBody.data;

  if (!isNetlifyDeployLookupConfigured(binding.env)) {
    return jsonResponse(
      200,
      getQueuedReceipt({ commit, deployId, errorMessage: 'Netlify deploy lookup is not configured.' })
    );
  }

  try {
    const receipt = commit
      ? await getDeployReceiptByCommit(commit, binding.env)
      : await getDeployReceiptByDeployId(deployId ?? '', binding.env);

    // The published deploy is what production actually serves — a "ready"
    // receipt alone can be a ready-but-unpublished deploy under locked Auto
    // Publishing. Absent fields (site lookup unavailable) mean "unknown",
    // never "not live".
    const publishedDeploy = await getPublishedProductionDeploy(binding.env);
    let productionConfirmed = publishedDeploy
      ? Boolean((commit && publishedDeploy.commit === commit) || (deployId && publishedDeploy.deployId === deployId))
      : undefined;

    // QA-W16-4: object exports accumulate on main behind [skip netlify] and
    // one release deploys every accumulated commit at once, so the
    // PUBLISHED deploy's commit is very often ahead of `commit` rather than
    // equal to it — even though `commit`'s changes are already live. Before
    // this reconciliation, that case reported deployStatus:"queued" /
    // productionConfirmed:false forever, contradicting the live site. Ask
    // GitHub whether `commit` is an ancestor of (or equal to) what is
    // actually published; if so, treat it as confirmed and reflect that in
    // the deployStatus returned to the caller too, not just the boolean.
    let reconciledReceipt: Partial<DeployReceipt> | undefined;
    if (commit && publishedDeploy?.commit && !productionConfirmed) {
      const targetIsAncestor = await isCommitAncestorOrEqual(commit, publishedDeploy.commit);
      if (targetIsAncestor) {
        productionConfirmed = true;
        reconciledReceipt = {
          ...(receipt ?? {}),
          commit,
          deployStatus: 'ready',
          errorMessage: '',
        };
      }
    }

    return jsonResponse(200, {
      ...(reconciledReceipt ?? receipt ?? getQueuedReceipt({ commit, deployId })),
      ...(reconciledReceipt
        ? {
            reconciled: true,
            reconciliationNote: `commit ${commit} is already included in the published deploy (${publishedDeploy?.commit}) via ancestry check — reported ready/confirmed instead of the raw by-commit lookup result.`,
          }
        : {}),
      ...(publishedDeploy ? { publishedDeploy, productionConfirmed } : {}),
    });
  } catch (error) {
    console.warn('Netlify deploy status lookup failed.', { commit, deployId, error });

    return jsonResponse(200, getQueuedReceipt({ commit, deployId }));
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
