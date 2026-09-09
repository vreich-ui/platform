/**
 * Admin taxonomy endpoint — returns existing tags and categories collected
 * from all workflow records, for use as suggestions in the publish UI.
 *
 * GET /.netlify/functions/admin-taxonomy
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { collectBlobListItems } from '../lib/blob-list.js';
import { getWorkflowBlobStore } from '../lib/blob-store.js';
import type { WorkflowRecord } from '../../schema/schema-v1.js';

type LambdaEvent = {
  blobs?: string;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
};

type WorkflowBlobStore = Awaited<ReturnType<typeof getWorkflowBlobStore>> & {
  list?: (options?: { prefix?: string; directories?: boolean; paginate?: boolean }) => Promise<unknown>;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: jsonHeaders,
  body: JSON.stringify({ ok: statusCode < 300, status: statusCode, ...body }),
});

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent) => {
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

  const adminState = await resolveAdminAccessFromEvent(event, undefined, binding);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });
  if (!adminState.isAdmin) return jsonResponse(403, { error: 'Admin access required' });

  try {
    const store = (await getWorkflowBlobStore(event, binding)) as WorkflowBlobStore;

    if (typeof store.list !== 'function') {
      return jsonResponse(200, { tags: [], categories: [] });
    }

    const listResult = await store.list({ prefix: 'workflows/by-id/', directories: false, paginate: true });
    const blobs = await collectBlobListItems(listResult as Parameters<typeof collectBlobListItems>[0]);

    const tagSet = new Set<string>();
    const categorySet = new Set<string>();

    await Promise.allSettled(
      blobs.map(async (blob) => {
        if (!blob.key.endsWith('.json')) return;
        try {
          const raw = await store.get(blob.key);
          if (!raw) return;
          const record = JSON.parse(raw) as WorkflowRecord;

          const pp = isRecord(record.input?.publication)
            ? (record.input.publication as Record<string, unknown>).publish_payload
            : undefined;

          if (isRecord(pp)) {
            if (Array.isArray(pp.tags)) {
              for (const t of pp.tags as unknown[]) {
                if (typeof t === 'string' && t.trim()) tagSet.add(t.trim().toLowerCase());
              }
            }
            if (typeof pp.category === 'string' && pp.category.trim()) {
              categorySet.add(pp.category.trim().toLowerCase());
            }
          }

          const taxRaw: unknown = record.input?.taxonomy;
          if (isRecord(taxRaw)) {
            if (Array.isArray(taxRaw.tags)) {
              for (const t of taxRaw.tags as unknown[]) {
                if (typeof t === 'string' && t.trim()) tagSet.add(t.trim().toLowerCase());
              }
            }
            if (typeof taxRaw.category === 'string' && taxRaw.category.trim()) {
              categorySet.add(taxRaw.category.trim().toLowerCase());
            }
          }
        } catch {
          // ignore individual record parse errors
        }
      })
    );

    return jsonResponse(200, {
      tags: [...tagSet].sort(),
      categories: [...categorySet].sort(),
    });
  } catch (error) {
    console.error('admin-taxonomy failed', error);
    return jsonResponse(500, { error: 'Failed to load taxonomy data' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
