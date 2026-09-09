/**
 * Site shim for 'site_genesis_lab_2': instantiates the core `admin-plugin-manifest` handler with
 * this site's SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/admin-plugin-manifest.ts; this file is the per-site wire.
 *
 * Functions-1.0: the handler is a named `handler` export.
 */
import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/admin-plugin-manifest.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/admin-plugin-manifest.js';

export const handler = createHandler(siteBinding);
