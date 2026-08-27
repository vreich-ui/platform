import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/admin-editorial-view.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/admin-editorial-view.js';

export const handler = createHandler(siteBinding);
