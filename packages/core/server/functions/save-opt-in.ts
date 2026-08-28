import type { SiteBinding } from '../lib/site-binding.js';
import { randomUUID } from 'node:crypto';

import { getOptInBlobStore } from '../lib/blob-store.js';
import { enqueueMemberLink, type MemberLinkDeps } from '../lib/member-link.js';
import { buildRecord, getHeader, isParseBodyFailure, parseBody } from '../lib/opt-in-record.js';

type LambdaEvent = {
  blobs?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
};

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const handlerImpl = async (event: LambdaEvent, memberLinkDeps: MemberLinkDeps = {}) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: jsonHeaders,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const input = parseBody(event);

  if (isParseBodyFailure(input)) {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({ error: 'Invalid request body' }),
    };
  }

  const record = input ? buildRecord(input, getHeader(event.headers, 'user-agent')) : undefined;

  if (!record) {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({ error: 'A formName is required to save opt-in metadata.' }),
    };
  }

  try {
    const date = record.submittedAt.slice(0, 10);
    const key = `opt-ins/${date}/${randomUUID()}.json`;
    const store = await getOptInBlobStore(event);

    await store.setJSON(key, record, {
      metadata: {
        formName: record.formName,
        submittedAt: record.submittedAt,
      },
    });

    enqueueMemberLink(event, record.email, memberLinkDeps);

    return {
      statusCode: 202,
      headers: jsonHeaders,
      body: JSON.stringify({ key, ok: true }),
    };
  } catch (error) {
    console.error('Failed to save opt-in metadata to Netlify Blobs.', error);

    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: 'Opt-in metadata could not be saved.' }),
    };
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler =
  (_binding: SiteBinding, memberLinkDeps: MemberLinkDeps = {}) =>
  (event: LambdaEvent) =>
    handlerImpl(event, memberLinkDeps);
