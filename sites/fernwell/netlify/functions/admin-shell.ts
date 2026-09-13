/**
 * Site shim for 'site_fernwell': instantiates the core `admin-shell` handler with
 * this site's SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/admin-shell.ts; this file is the per-site wire.
 *
 * Functions-1.0: the handler is a named `handler` export.
 */
import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/admin-shell.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/admin-shell.js';

export const handler = createHandler(siteBinding);
