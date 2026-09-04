/**
 * Install-page client (W7.1) — the browser half of `plugin-install`.
 *
 * Same split as `plugins-client.ts`: `packages/core/admin/**\/*.tsx` is
 * excluded from the test compile, so everything a test can assert lives here
 * and the page is a thin renderer.
 *
 * The one behaviour worth naming: a download is fetched WITH the bearer and
 * saved as a blob, never opened with `window.open`. A top-level navigation
 * carries no Authorization header, so an "open the URL" download answered
 * `{"ok":false,"status":401}` and the browser displayed that JSON as if it
 * were the file. Every export button on the admin plugins page was dead that
 * way for weeks (see `fetchPluginExport`'s note); this endpoint is newer and
 * starts on the right side of it.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { InstallCard, InstallFacts } from '../plugin-install.js';

export const INSTALL_ENDPOINT = '/api/plugin-install';

export interface InstallPageState {
  /** False when the tenant has promoted no bundle: the page says so and offers nothing. */
  ready: boolean;
  tenant: string;
  brand_name: string;
  facts: InstallFacts | null;
  cards: InstallCard[];
  aggression_ceiling?: Record<string, number>;
  approval_posture?: string;
}

/** The public read. Deliberately tokenless — the page must render before anyone signs in. */
export const fetchInstallPage = async (): Promise<InstallPageState> => {
  const response = await fetch(INSTALL_ENDPOINT, { headers: { Accept: 'application/json' } });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body.ok === false) {
    throw new Error(String(body.error ?? `The install page could not be loaded (${response.status}).`));
  }
  return body as unknown as InstallPageState;
};

export interface DownloadedBundle {
  blob: Blob;
  filename: string;
}

/** `Content-Disposition`'s filename — the bundle name carries the manifest version. */
export const filenameFromDisposition = (disposition: string | null, fallback: string): string => {
  if (!disposition) return fallback;
  const quoted = disposition.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1];
  const bare = disposition.match(/filename\s*=\s*([^;]+)/i);
  return bare ? bare[1].trim() : fallback;
};

/**
 * Fetch one bundle as the signed-in member.
 *
 * The refusals this surfaces are the whole point of the endpoint's error
 * codes: `install_requires_member` means sign in, `install_requires_editor`
 * means the account is real but read-only, and `no_active_manifest` means
 * nothing the installer does will help. The page shows the server's sentence
 * verbatim — three different problems that all used to read "403".
 */
export const downloadInstallBundle = async (
  getToken: GetToken,
  href: string,
  fallbackName: string
): Promise<DownloadedBundle> => {
  const token = await getToken();
  const response = await fetch(href, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  if (!response.ok) {
    let reason = `Download failed (${response.status}).`;
    try {
      const body = (await response.clone().json()) as { error?: string };
      if (body.error) reason = body.error;
    } catch {
      /* a non-JSON body: the status is all there is to say */
    }
    throw new Error(reason);
  }

  // A 2xx is not proof of a bundle: the refusal envelope is JSON, and writing
  // it to disk as a .zip hands the installer a file that will not open instead
  // of the reason it could not be built.
  if (/application\/json/i.test(response.headers.get('Content-Type') ?? '')) {
    let reason = 'The server returned a message instead of a bundle.';
    try {
      const body = (await response.clone().json()) as { error?: string };
      if (body.error) reason = body.error;
    } catch {
      /* not JSON after all */
    }
    throw new Error(reason);
  }

  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get('Content-Disposition'), fallbackName),
  };
};
