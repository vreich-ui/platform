/**
 * Site shim for 'site_zilberman': instantiates the core `artifact-upload` handler with
 * this site's SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/artifact-upload.ts; this file is the per-site wire.
 *
 * Functions-2.0 (config.path): the handler is the DEFAULT export.
 */
import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/artifact-upload.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/artifact-upload.js';

export default createHandler(siteBinding);
