import '../../config/policy-bindings.js';
import { createHandler } from '../../../../packages/core/server/functions/plugin-install.js';
import { siteBinding } from '../../config/site-binding.js';

export * from '../../../../packages/core/server/functions/plugin-install.js';

export const handler = createHandler(siteBinding);
