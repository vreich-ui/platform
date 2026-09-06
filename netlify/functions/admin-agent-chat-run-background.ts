/**
 * Site shim (W11 T11.4): instantiates the core `admin-agent-chat-run-background` handler with the
 * Dr-Lurie SiteBinding. The implementation is fleet law in
 * packages/core/server/functions/admin-agent-chat-run-background.ts; this file is the per-site wire.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import { createHandler } from '../../packages/core/server/functions/admin-agent-chat-run-background.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';
import { configureDrlurieMcpSiblings } from '../lib/mcp-siblings.js';

configureDrlurieMcpSiblings();

export * from '../../packages/core/server/functions/admin-agent-chat-run-background.js';

export const handler = createHandler(drlurieSiteBinding);
