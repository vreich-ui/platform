/**
 * Site shim (M3.4): instantiates the core `governance-probe-refresh` handler with
 * the Dr-Lurie SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/governance-probe-refresh.ts; this file is the per-site wire.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import { createHandler } from '../../packages/core/server/functions/governance-probe-refresh.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';

export * from '../../packages/core/server/functions/governance-probe-refresh.js';

export const handler = createHandler(drlurieSiteBinding);
