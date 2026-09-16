/**
 * Site shim (M0.2): instantiates the core `object-index-rebuild` handler with
 * the Dr-Lurie SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/object-index-rebuild.ts; this file is the per-site wire.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import { createHandler } from '../../packages/core/server/functions/object-index-rebuild.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';

export * from '../../packages/core/server/functions/object-index-rebuild.js';

export const handler = createHandler(drlurieSiteBinding);
