/**
 * zilberman's build entry — a thin entry over the shared shell in
 * `packages/core/app` (W14 T14.1). Everything structural lives there.
 *
 * The import is RELATIVE, not `@core/…`: Astro loads this file before Vite's
 * aliases exist.
 *
 *   npx astro build --config sites/zilberman/astro.config.ts
 */
import { defineSiteAstroConfig } from '../../packages/core/app/site-astro-config';

import { siteConfig } from './site.config';

export default defineSiteAstroConfig({
  siteDir: 'sites/zilberman',
  site: siteConfig.canonicalHost,
  imageDomains: siteConfig.imageDomains,
});
