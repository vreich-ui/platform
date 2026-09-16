import type { EditorialArtifact } from './editorial-assets.js';
import type { StudioRecord } from './studio-client.js';
import { MAJOR_KEY_ARTIFACT_REF_RE } from '../artifact-paths.js';

type Bag = Record<string, unknown>;

const asBag = (value: unknown): Bag =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Bag) : {};
const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export interface VisualIdentitySwatch {
  name: string;
  value: string;
}

export interface VisualIdentityTheme {
  objectId: string;
  label: string;
  active: boolean;
}

export interface VisualIdentityViewModel {
  publicationName: string;
  logoText: string;
  logoImageConfigured: boolean;
  availableLogo?: EditorialArtifact;
  colors: VisualIdentitySwatch[];
  typography: VisualIdentitySwatch[];
  previewUrl?: string;
  activeThemeLabel?: string;
  themes: VisualIdentityTheme[];
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const bag = value as Bag;
  return `{${Object.keys(bag)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(bag[key])}`)
    .join(',')}}`;
};

const tokenRows = (tokens: unknown, field: 'colors' | 'fonts'): VisualIdentitySwatch[] =>
  Object.entries(asBag(asBag(tokens)[field]))
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([name, value]) => ({ name, value: value as string }));

const themeName = (theme: StudioRecord): string => stringValue(asBag(theme.body).name) ?? 'Untitled theme';

/**
 * A read-only aggregate lens over existing site, theme, and media records.
 * It deliberately creates no new source of truth: site.brandTokens are the
 * active values; a matching theme is presentation-only context.
 */
export function buildVisualIdentityViewModel({
  site,
  themes,
  artifacts,
  fallbackName,
}: {
  site: StudioRecord;
  themes: readonly StudioRecord[];
  artifacts: readonly EditorialArtifact[];
  fallbackName: string;
}): VisualIdentityViewModel {
  const body = asBag(site.body);
  const logo = asBag(body.logo);
  const tokens = asBag(body.brandTokens);
  const siteTokenKey = stable(tokens);
  const resolvedThemes = themes.map((theme) => ({
    objectId: theme.object_id,
    label: themeName(theme),
    active: stable(asBag(theme.body).tokens) === siteTokenKey,
  }));
  const activeTheme = resolvedThemes.find((theme) => theme.active);
  const previewCandidate = stringValue(asBag(body.urls).base);
  const previewUrl =
    previewCandidate && (/^https:\/\//i.test(previewCandidate) || previewCandidate.startsWith('/'))
      ? previewCandidate
      : undefined;

  return {
    publicationName: stringValue(body.name) ?? fallbackName,
    logoText: stringValue(logo.text) ?? stringValue(body.name) ?? fallbackName,
    logoImageConfigured: Boolean(stringValue(logo.imageAssetRef)),
    availableLogo: artifacts.find((artifact) => artifact.family === 'logos'),
    colors: tokenRows(tokens, 'colors'),
    typography: tokenRows(tokens, 'fonts'),
    previewUrl,
    activeThemeLabel: activeTheme?.label,
    themes: resolvedThemes,
  };
}

// ─── the logo write (T2.2) ──────────────────────────────────────────────────

export type SetSiteLogoOp = { op: 'set_site_fields'; fields: { logo: { imageAssetRef: string } } };

/**
 * The ONE op the "Mark" card's two write actions (upload / "Use this logo")
 * both build. Pure and returns `undefined` rather than emitting a half-op —
 * `buildAcceptProposalOp`'s shape (visual-identity-propose-client.ts) — so the
 * caller shows an honest "nothing to save" instead of sending a patch that
 * will bounce.
 *
 * `artifactRef` must already be the RAW Major Key
 * (`{image|pdf}/<id>/<sha256>.<ext>`, artifact-paths.ts) — never a `/img/...`
 * servable path — because `logo.imageAssetRef` is a `*AssetRef` field
 * (site-v1.ts) and every `*AssetRef` field is defined to hold the raw ref,
 * never the servable one (`publicPathForArtifactRef`'s doc comment).
 * `object-validate.ts`'s `checkArtifactTrust` rejects anything else at
 * validate time regardless, but failing the regex HERE gives the operator an
 * immediate, honest error instead of a round trip that ends in a 422.
 *
 * Emits ONLY `{ logo: { imageAssetRef } }` — never `brandTokens`,
 * `brandImagery` or `tracking`, which `set_site_fields` itself refuses
 * (object-patch-ops.ts) — so this builder can never become the footgun that
 * hands the caller an op the server was always going to bounce for a
 * different field it never meant to touch.
 *
 * `set_site_fields` is a DEEP-PARTIAL merge over the site body, so sending
 * only `logo.imageAssetRef` leaves `logo.text` exactly as it was; the builder
 * therefore never needs to read the current body to preserve it.
 */
export function buildSetSiteLogoOp(input: { artifactRef?: string }): SetSiteLogoOp | undefined {
  const ref = input.artifactRef?.trim();
  if (!ref || !MAJOR_KEY_ARTIFACT_REF_RE.test(ref)) return undefined;
  return { op: 'set_site_fields', fields: { logo: { imageAssetRef: ref } } };
}
