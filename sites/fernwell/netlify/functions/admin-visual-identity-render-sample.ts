import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/admin-visual-identity-render-sample.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/admin-visual-identity-render-sample.js';
export const handler = createHandler(siteBinding);
