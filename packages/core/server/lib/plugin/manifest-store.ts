/**
 * Plugin manifest store (W1.1). One doc per site in its own blob store,
 * following governance-store.ts: a zod-validated document, a draft/active
 * pair, and an append-only history of who rendered or promoted what.
 *
 * A corrupt or unparseable doc resolves to the empty doc rather than throwing —
 * the manifest is derived, so the recovery for a bad doc is "render again",
 * never an outage on the admin page that offers the button.
 */
import { getPluginManifestBlobStore as getStore } from '../blob-store.js';
import type { SiteBinding } from '../site-binding.js';
import {
  emptyPluginManifestDoc,
  pluginManifestDocSchema,
  type ManifestBundle,
  type PluginManifestDoc,
} from './manifest-types.js';

export const PLUGIN_MANIFEST_DOC_KEY = 'manifest.v1';

export interface PluginManifestBlobStore {
  get(key: string, options?: { type?: string }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<unknown>;
}

export const getPluginManifestBlobStore = async (
  event: unknown,
  binding?: SiteBinding
): Promise<PluginManifestBlobStore> => (await getStore(event, binding)) as unknown as PluginManifestBlobStore;

export const getPluginManifestDoc = async (store: PluginManifestBlobStore): Promise<PluginManifestDoc> => {
  let raw: unknown;
  try {
    raw = await store.get(PLUGIN_MANIFEST_DOC_KEY, { type: 'json' });
  } catch {
    return emptyPluginManifestDoc();
  }
  if (raw === null || raw === undefined || raw === '') return emptyPluginManifestDoc();
  const parsed = pluginManifestDocSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyPluginManifestDoc();
};

export const putPluginManifestDoc = async (
  store: PluginManifestBlobStore,
  doc: PluginManifestDoc
): Promise<PluginManifestDoc> => {
  const validated = pluginManifestDocSchema.parse(doc);
  await store.setJSON(PLUGIN_MANIFEST_DOC_KEY, validated);
  return validated;
};

/** History is append-only and bounded — the newest 50 entries survive. */
const withHistory = (
  doc: PluginManifestDoc,
  entry: { actor_email: string; action: string; manifest_version?: string; detail?: string },
  at: string
): PluginManifestDoc['history'] => [{ at, ...entry }, ...doc.history].slice(0, 50);

export const recordRenderedDraft = (
  doc: PluginManifestDoc,
  bundle: ManifestBundle,
  actorEmail: string
): PluginManifestDoc => ({
  ...doc,
  draft: bundle,
  updated_by: actorEmail,
  updated_at: bundle.rendered_at,
  history: withHistory(
    doc,
    {
      actor_email: actorEmail,
      action: 'render_draft',
      manifest_version: bundle.manifest_version,
      ...(bundle.warnings.length ? { detail: `${bundle.warnings.length} warning(s)` } : {}),
    },
    bundle.rendered_at
  ),
});

/**
 * Promote the draft to active — the version an export downloads. Refuses when
 * there is no draft, so "promote" can never publish an empty bundle.
 */
export const promoteDraft = (
  doc: PluginManifestDoc,
  actorEmail: string,
  at: string
): { ok: true; doc: PluginManifestDoc } | { ok: false; error: string } => {
  if (!doc.draft) return { ok: false, error: 'There is no rendered draft to promote.' };
  return {
    ok: true,
    doc: {
      ...doc,
      active: doc.draft,
      updated_by: actorEmail,
      updated_at: at,
      history: withHistory(
        doc,
        { actor_email: actorEmail, action: 'promote_active', manifest_version: doc.draft.manifest_version },
        at
      ),
    },
  };
};
