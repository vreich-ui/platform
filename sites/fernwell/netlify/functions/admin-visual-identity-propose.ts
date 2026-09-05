import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/admin-visual-identity-propose.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/admin-visual-identity-propose.js';
export const handler = createHandler(siteBinding);
