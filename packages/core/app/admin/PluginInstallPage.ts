/**
 * Site island entry (W7.1): registers this site's policy/identity providers,
 * then re-exports the core component.
 *
 * The indirection is not decoration. An island is hydrated in the browser from
 * its own module graph, so it must import the site bindings itself — the
 * `.astro` page's server-side import does not travel with it, and a component
 * that resolves the site identity without them throws at hydration.
 */
import '@site/config/policy-bindings';

export { default } from '@core/admin/PluginInstallPage';
