/**
 * Site shim for 'site_zilberman': instantiates the core `save-commerce-event` handler with
 * this site's SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/save-commerce-event.ts; this file is the per-site wire.
 *
 * Functions-1.0: the handler is a named `handler` export.
 */
import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/save-commerce-event.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/save-commerce-event.js';

export const handler = createHandler(siteBinding);
