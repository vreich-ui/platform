/**
 * Site shim for 'site_genesis_lab_2': instantiates the core `plugin-actions` handler with
 * this site's SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/plugin-actions.ts; this file is the per-site wire.
 *
 * Functions-1.0: the handler is a named `handler` export.
 */
import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/plugin-actions.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/plugin-actions.js';

export const handler = createHandler(siteBinding);
