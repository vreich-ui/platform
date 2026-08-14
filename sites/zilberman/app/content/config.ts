/**
 * zilberman's content collections. The collection SHAPES are fleet law
 * and live in the shell; this file supplies only this deployment's export root.
 * Astro requires the file at `<srcDir>/content/config.ts`, which is why every
 * site carries its own three-line copy.
 *
 * `postDir` is pinned to THIS site's own (empty) legacy shelf — W15 S3: the
 * shared default is `src/data/post`, which is Dr-Lurie's preserved legacy
 * content, and inheriting it published Dr-Lurie's committed test post on
 * every tenant with blog routes. Every real article here is a `content_item`
 * object; this shelf stays empty by design.
 */
import { buildSiteCollections } from '@core/app/content/collections';

export const collections = buildSiteCollections({
  dataRoot: 'sites/zilberman/data/site',
  postDir: 'sites/zilberman/data/post',
});
