/**
 * Site shim for 'site_zilberman': instantiates the core `admin-ask-ai-object` handler with
 * this site's SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/admin-ask-ai-object.ts; this file is the per-site wire.
 *
 * Functions-1.0: the handler is a named `handler` export.
 */
import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/admin-ask-ai-object.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/admin-ask-ai-object.js';

export const handler = createHandler(siteBinding);
