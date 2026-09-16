/**
 * Site shim (M4): instantiates the core `analytics-snapshot-warm` handler with
 * the Dr-Lurie SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/analytics-snapshot-warm.ts; this file is the per-site wire.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import { createHandler } from '../../packages/core/server/functions/analytics-snapshot-warm.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';

export * from '../../packages/core/server/functions/analytics-snapshot-warm.js';

export const handler = createHandler(drlurieSiteBinding);
