import type { EditorialArtifact } from './editorial-assets.js';
import type { StudioRecord } from './studio-client.js';

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
