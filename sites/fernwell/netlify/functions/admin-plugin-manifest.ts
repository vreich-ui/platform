import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/admin-plugin-manifest.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/admin-plugin-manifest.js';

export const handler = createHandler(siteBinding);
