/**
 * Site shim (W11 T11.4): instantiates the core `editorial-request-sweep` handler with the
 * Dr-Lurie SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/editorial-request-sweep.ts; this file is the per-site wire.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import { createHandler } from '../../packages/core/server/functions/editorial-request-sweep.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';

export * from '../../packages/core/server/functions/editorial-request-sweep.js';

export const handler = createHandler(drlurieSiteBinding);
