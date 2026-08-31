import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/plugin-actions.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/plugin-actions.js';

export const handler = createHandler(siteBinding);
