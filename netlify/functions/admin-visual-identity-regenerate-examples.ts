import '../../sites/drlurie/config/policy-bindings.js';
import { createHandler } from '../../packages/core/server/functions/admin-visual-identity-regenerate-examples.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';

export * from '../../packages/core/server/functions/admin-visual-identity-regenerate-examples.js';
export const handler = createHandler(drlurieSiteBinding);
