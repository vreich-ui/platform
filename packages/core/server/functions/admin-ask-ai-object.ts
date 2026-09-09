/**
 * Function name: Admin_Ask_AI_Object
 * Required method: POST
 * Auth: Netlify Identity (admin email allowlist).
 *
 * Generic Ask-AI for CMS objects (T1.6) — the browser-facing wrapper around
 * the pure core in netlify/lib/ask-ai-object.ts. Read-only with respect to
 * Netlify Blobs: takes no lock and writes nothing. Returns a suggestion the
 * reviewer applies through the object_patch verb (the T1.4 review path); it
 * never writes the record directly.
 *
 * This endpoint was deliberately kept separate from the legacy article
 * admin-ask-ai-node.ts (Tier 1 had its own path) rather than modifying that
 * file; admin-ask-ai-node.ts retired at T9.24 once every article moved onto
 * the content_item object substrate, and this generic path now serves them
 * too — shared behavior (selection-based UX, the forced-tool call,
 * null-stripping) always lived in the reusable core, never in the article
 * file.
 *
 * POST body: { object_type, object_id, section_id?, node_id?, selected_text?, image_ref?, instruction }
 * (`section_id` scopes a PAGE request to one section instance; `node_id`
 * scopes a content_item request to one article node (W7.8); `image_ref`
 * carries a "Re: <image>" reference with its public URL — the edit-mode
 * canvas paths; see netlify/lib/ask-ai-object.ts.)
 * Requires OPENAI_API_KEY; model override via OPENAI_MODEL (default gpt-4o).
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { z } from 'zod';

import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { askAiForObject, type AskAiObjectStore } from '../lib/ask-ai-object.js';
import { getAgentProfilesBlobStore, getProfilesDoc, resolveProfile } from '../lib/agent/profiles.js';

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const bodySchema = z
  .object({
    object_type: z.string().min(1),
    object_id: z.string().min(1),
    section_id: z.string().min(1).optional(),
    node_id: z.string().min(1).optional(),
    selected_text: z.string().max(4000).optional(),
    // Canvas image chips ("Re: portrait.png"): prompt context only — the
    // copy-only guard still strips image fields from every suggestion.
    image_ref: z
      .object({
        field: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
        url: z.url().max(2000),
      })
      .strict()
      .optional(),
    instruction: z.string().min(1).max(2000),
  })
  .strict();

type LambdaEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
};

const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  statusCode: status,
  headers: jsonHeaders,
  body: JSON.stringify({ ok: status >= 200 && status < 300, status, ...body }),
});

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const adminState = await resolveAdminAccessFromEvent(event, context, binding);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });
  if (!adminState.isAdmin) return jsonResponse(403, { error: 'Admin access required' });

  let rawBody: unknown;
  try {
    const text =
      event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');
    rawBody = JSON.parse(text);
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) return jsonResponse(400, { error: 'Invalid request', issues: parsed.error.issues });

  try {
    // T9.26 (§4a): the suggestion speaks through the OBJECT'S dedicated agent
    // — profile resolution (object → type → site default) supplies provider +
    // model; nothing is hardcoded here anymore. Copy-only guard and schema
    // behavior are unchanged in the core.
    const profilesDoc = await getProfilesDoc(await getAgentProfilesBlobStore(event, binding), new Date().toISOString());
    const profile = resolveProfile(profilesDoc, {
      objectId: parsed.data.object_id,
      objectType: parsed.data.object_type,
    });
    const apiKey = profile.provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return jsonResponse(500, {
        error: `${profile.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} is not configured for the assigned agent "${profile.name}".`,
      });
    }

    const store = (await getSiteObjectsBlobStore(event, binding)) as unknown as AskAiObjectStore;
    const result = await askAiForObject(store, parsed.data, {
      apiKey,
      model: profile.model,
      provider: profile.provider,
    });
    return jsonResponse(result.status, result.body);
  } catch (error) {
    console.error('admin-ask-ai-object failed', {
      object_type: parsed.data.object_type,
      object_id: parsed.data.object_id,
      error,
    });
    return jsonResponse(500, { error: error instanceof Error ? error.message : 'AI suggestion failed' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
