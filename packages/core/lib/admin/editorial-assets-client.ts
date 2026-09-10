import type { GetToken } from '../edit-mode/verbs-client.js';
import type { EditorialAssetsPayload } from './editorial-assets.js';
import { currentPageSignal } from './page-generation.js';

const ENDPOINT = '/.netlify/functions/admin-editorial-assets';

/** T1.1: a plain page-load read, no cross-navigation store — always rides the current page-generation signal. */
export async function fetchEditorialAssets(getToken: GetToken): Promise<EditorialAssetsPayload> {
  const token = await getToken();
  const response = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${token}` }, signal: currentPageSignal() });
  const body = (await response.json().catch(() => ({}))) as Partial<EditorialAssetsPayload> & { error?: string };
  if (!response.ok) throw new Error(body.error || `Media could not be loaded (${response.status}).`);
  return {
    pdf_templates: Array.isArray(body.pdf_templates) ? body.pdf_templates : [],
    artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
    pdf_templates_available: body.pdf_templates_available === true,
  };
}
