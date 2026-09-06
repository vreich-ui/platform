import '../../sites/drlurie/config/policy-bindings.js';
import { createHandler } from '../../packages/core/server/functions/admin-plugin-manifest.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';
import { configureDrlurieMcpSiblings } from '../lib/mcp-siblings.js';

configureDrlurieMcpSiblings();

export * from '../../packages/core/server/functions/admin-plugin-manifest.js';

export const handler = createHandler(drlurieSiteBinding);
