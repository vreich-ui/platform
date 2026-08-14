/**
 * Site shim for 'site_zilberman': instantiates the core `save-opt-in` handler with
 * this site's SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/save-opt-in.ts; this file is the per-site wire.
 *
 * Functions-1.0: the handler is a named `handler` export.
 */
import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/save-opt-in.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/save-opt-in.js';

export const handler = createHandler(siteBinding);
