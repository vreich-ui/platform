/**
 * `bio` registry module (T3.2, D§3.5) — the reusable "person intro" (the
 * "Meet Dr. Lurié" homepage section, A§2.1, and the /about intro). An optional
 * `portrait` ({src, alt}) renders a photo by URL; `portraitAssetRef` remains
 * the trusted-artifact path, still unrendered. No references resolved in v1.
 */
import { getSiteIdentity } from '../../site-identity.js';
import { sectionVariantDataSchema, type EmptyResolved, type SectionComponentDefinition } from './types.js';

/**
 * The asset-host example in the portrait help string, resolved defensively.
 *
 * This used to be a bare module-scope `getSiteIdentity()` destructure, which
 * made merely IMPORTING this registry module throw wherever no tenant has
 * bound its policy providers. That was invisible until W1 T1.1, when
 * `object-validate.ts` started reading the component footprints and therefore
 * loading every definition: fleet-law validation code, and its own co-located
 * tests, do not bind a site. A HELP STRING must never be able to fail a
 * module load.
 */
const assetUrlExample = (): string => {
  try {
    const { assetHost, assetFolder } = getSiteIdentity();
    return `${assetHost}/${assetFolder}/…`;
  } catch {
    return 'your site asset host';
  }
};

export const bioDefinition: SectionComponentDefinition<'bio', EmptyResolved> = {
  type: 'bio',
  schema: sectionVariantDataSchema('bio'),
  footprint: { region: 'flow' },
  editor: {
    label: 'Bio',
    icon: 'tabler:user',
    useWhen:
      'Author/credibility block: portrait, introduction, credential trust notes, disclaimer. Typically once per site area — the about page or an article-adjacent trust section.',
    fieldHints: {
      kicker: { label: 'Kicker', help: 'Small uppercase lead-in line above the heading.', widget: 'text' },
      heading: { label: 'Heading', widget: 'text' },
      portrait: {
        label: 'Portrait',
        help:
          'Optional photo shown under the heading (image URL + alt text). Use a site asset URL ' +
          `(${assetUrlExample()} or a first-party /images/… path). NEVER link ` +
          'repository files (raw.githubusercontent.com, images.weserv.nl or other proxies of the repo): ' +
          'the deploy secrets scanner blocks EVERY production deploy when the repo slug appears in ' +
          'published content.',
        widget: 'image_url',
      },
      body: { label: 'Introduction', widget: 'richtext' },
      trustNotes: { label: 'Trust notes', help: 'Credential lines shown with an accent border.', widget: 'text_list' },
      disclaimer: { label: 'Disclaimer', help: 'Small print under the trust notes.', widget: 'text' },
      anchor: { label: 'Anchor', help: 'Public URL fragment for this section (e.g. "about").', widget: 'text' },
    },
    defaultData: {
      heading: 'About',
      body: '<p>Introduce the author here.</p>',
      trustNotes: [],
    },
  },
};
