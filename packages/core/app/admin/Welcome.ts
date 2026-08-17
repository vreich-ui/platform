/**
 * Site island entry (W11 T11.5): registers this site's policy/identity
 * providers, then re-exports the core admin component. Core admin code never
 * imports site config — this wrapper is the client-bundle seam that makes
 * getSiteIdentity()/active*Policy() resolve inside the island.
 */
import '@site/config/policy-bindings';

export { default } from '@core/admin/Welcome';
