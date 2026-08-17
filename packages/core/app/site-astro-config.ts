/**
 * The shared Astro build entry (W14 T14.1).
 *
 * Before this, exactly one Astro build existed and it was hardwired to
 * Dr-Lurie: `src/` at the repo root WAS the app. The shell now lives here in
 * `packages/core/app/` and every `sites/<client>/astro.config.ts` is a thin
 * entry over it:
 *
 *     import { defineSiteAstroConfig } from '@core/app/site-astro-config';
 *     export default defineSiteAstroConfig({ siteDir: 'sites/acme' });
 *
 * Three aliases carry the seam, and they are the whole contract:
 *
 *   `~`      → `packages/core/app`  — the SHELL. Layouts, components, utils.
 *              Fleet law: identical bytes for every client.
 *   `@core`  → `packages/core`      — the engine below the shell.
 *   `@site`  → `sites/<client>`     — THIS deployment's values. Config bundle,
 *              assets, committed exports. Resolved per build, which is why
 *              shell code may import `@site/...` without naming a tenant.
 *
 * `root` stays the repo root for every site so workspace resolution and the
 * repo-relative content-collection globs behave identically per build; only
 * `srcDir`, `publicDir`, and `outDir` move.
 *
 * Routing authority stays a committed FILE per Wolf B2: each site's
 * `config.yaml` feeds the astrowind integration, and `site.config.ts` supplies
 * the canonical host and image domains.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, passthroughImageService } from 'astro/config';

import sitemap from '@astrojs/sitemap';
import tailwind from '@astrojs/tailwind';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import partytown from '@astrojs/partytown';
import icon from 'astro-icon';
import compress from 'astro-compress';
import type { AstroIntegration } from 'astro';

import astrowind from '../../../vendor/integration';

import { shellRoutes } from './shell-routes';
import { siteRedirectsFile } from './site-redirects-integration';
import { identityEmailTemplates } from './identity-email-templates-integration';

import { readingTimeRemarkPlugin, responsiveTablesRehypePlugin, lazyImagesRehypePlugin } from './utils/frontmatter';

/** `packages/core/app` — the shell root, the `~` alias target. */
export const SHELL_DIR = path.dirname(fileURLToPath(import.meta.url));
/** `packages/core` — the `@core` alias target. */
export const CORE_DIR = path.resolve(SHELL_DIR, '..');
/** The monorepo root; every site builds with this as Astro's `root`. */
export const REPO_ROOT = path.resolve(CORE_DIR, '..', '..');

export interface SiteAstroConfigOptions {
  /** Repo-relative site directory, e.g. `sites/drlurie`. */
  siteDir: string;
  /** Canonical public origin (site.config.ts's `canonicalHost`). */
  site: string;
  /** Remote image hosts this site is allowed to optimize (site.config.ts). */
  imageDomains?: string[];
  /**
   * Repo-relative build output. Defaults to `<siteDir>/dist`. Dr-Lurie pins
   * the repo-root `dist` until T14.3 repoints the Netlify projects, so the
   * live deploy's `publish` path does not move mid-wave.
   */
  outDir?: string;
}

const hasExternalScripts = false;
const whenExternalScripts = (items: (() => AstroIntegration) | (() => AstroIntegration)[] = []) =>
  hasExternalScripts ? (Array.isArray(items) ? items.map((item) => item()) : [items()]) : [];

export const defineSiteAstroConfig = (options: SiteAstroConfigOptions) => {
  const siteRoot = path.resolve(REPO_ROOT, options.siteDir);

  return defineConfig({
    root: REPO_ROOT,
    srcDir: path.join(siteRoot, 'app'),
    publicDir: path.join(siteRoot, 'public'),
    outDir: path.resolve(REPO_ROOT, options.outDir ?? path.join(options.siteDir, 'dist')),

    site: options.site,
    output: 'static',

    integrations: [
      tailwind({
        applyBaseStyles: false,
        // Absolute, for the same reason as the astrowind config path below:
        // Netlify builds from the project's base directory, and a relative
        // lookup silently falls back to tailwind's defaults (empty `content`),
        // which turns every `@apply` in the shell's stylesheet into a build
        // error about a class that "does not exist".
        configFile: path.join(REPO_ROOT, 'tailwind.config.js'),
      }),
      sitemap(),
      mdx(),
      // React renderer — scoped in practice to /admin/* islands (W9). No public
      // page mounts a React component, so no reader page loads the React runtime.
      react(),
      icon({
        include: {
          tabler: ['*'],
          'flat-color-icons': [
            'template',
            'gallery',
            'approval',
            'document',
            'advertising',
            'currency-exchange',
            'voice-presentation',
            'business-contact',
            'database',
          ],
        },
      }),

      ...whenExternalScripts(() =>
        partytown({
          config: { forward: ['dataLayer.push'] },
        })
      ),

      compress({
        CSS: true,
        HTML: {
          'html-minifier-terser': {
            removeAttributeQuotes: false,
          },
        },
        Image: false,
        JavaScript: true,
        SVG: false,
        Logger: 1,
      }),

      astrowind({
        // ABSOLUTE: the astrowind integration resolves this against the process
        // cwd, and Netlify runs the build from the project's BASE DIRECTORY,
        // not the repo root. A repo-relative path here builds fine locally and
        // dies on Netlify with a config-not-found — so the whole build is made
        // cwd-independent instead (Astro's own `root` is already absolute).
        config: path.join(siteRoot, 'config.yaml'),
      }),

      // The /admin workspace is fleet law — injected, not copied per site.
      shellRoutes(),
      // W14 F6: serve the redirects that retirement records (Wolf's ruling 3).
      siteRedirectsFile({ siteDir: siteRoot }),
      // W18 T18.0c: the Netlify Identity e-mail templates (all four link to
      // /admin/accept) — fleet law, published by every tenant at
      // /emails/identity/*.html; the console path is set per site (runbook).
      identityEmailTemplates(),
    ],

    image: {
      service: passthroughImageService(),
      domains: options.imageDomains ?? [],
    },

    markdown: {
      remarkPlugins: [readingTimeRemarkPlugin],
      rehypePlugins: [responsiveTablesRehypePlugin, lazyImagesRehypePlugin],
    },

    vite: {
      ssr: {
        // Dual CJS/ESM packages: let vite BUNDLE their ESM build into the SSR
        // output rather than letting Node 20 (Netlify's NODE_VERSION) require()
        // the CJS build, whose named exports its ESM loader cannot see —
        // `documentToHtmlString` otherwise throws "Named export not found" and
        // fails the production build (W14, fernwell's first build; the article
        // render path in packages/core/lib/richtext/render-html.ts pulls them in).
        noExternal: ['@contentful/rich-text-html-renderer', '@contentful/rich-text-types'],
      },
      resolve: {
        // Array form (ordered, regex-capable) because ONE prefix is split by
        // ownership: `~/assets/**` is the site's media — and that spelling is
        // baked into stored content (`to-markdown.ts` normalizes committed
        // asset paths to `~/assets/…`, and article bodies carry it), so it
        // cannot be renamed without rewriting published data. It therefore
        // resolves into `sites/<client>/assets/`, while every other `~/…`
        // resolves into the shell. The shell's own stylesheets live at
        // `~/styles/` for exactly this reason.
        alias: [
          { find: /^~\/assets\//, replacement: `${siteRoot}/assets/` },
          { find: /^~\//, replacement: `${SHELL_DIR}/` },
          { find: /^@core\//, replacement: `${CORE_DIR}/` },
          { find: /^@site\//, replacement: `${siteRoot}/` },
        ],
      },
    },
  });
};
