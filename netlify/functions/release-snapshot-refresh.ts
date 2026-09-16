/**
 * Site shim (M1): instantiates the core `release-snapshot-refresh` handler with
 * the Dr-Lurie SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/release-snapshot-refresh.ts; this file is the per-site wire.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import { createHandler } from '../../packages/core/server/functions/release-snapshot-refresh.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';

export * from '../../packages/core/server/functions/release-snapshot-refresh.js';

export const handler = createHandler(drlurieSiteBinding);
