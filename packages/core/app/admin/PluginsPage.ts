/**
 * Site island entry (W5.1): registers this site's policy/identity providers,
 * then re-exports the core admin component.
 */
import '@site/config/policy-bindings';

export { default } from '@core/admin/PluginsPage';
