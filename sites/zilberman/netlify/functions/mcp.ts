/**
 * Site shim for 'site_zilberman's MCP endpoint. The server is fleet law in
 * packages/core/server/functions/mcp.ts; this file is the per-site wire.
 *
 * This site has no legacy article path, so the legacy trio is not injected and
 * the tools that need it are absent from this site's tool list — the correct
 * outcome, not a gap.
 */
import '../../config/policy-bindings.js';

import { configureMcp } from '../../../../packages/core/server/functions/mcp.js';
import { createHandler as createSaveArtifactHandler } from '../../../../packages/core/server/functions/save-artifact.js';
import { createHandler as createObjectStoreHandler } from '../../../../packages/core/server/functions/object-store.js';
import { createHandler as createDeployStatusHandler } from '../../../../packages/core/server/functions/deploy-status.js';
import { siteBinding } from '../../config/site-binding.js';

configureMcp({
  saveArtifactHandler: createSaveArtifactHandler(siteBinding),
  objectStoreHandler: createObjectStoreHandler(siteBinding),
  deployStatusHandler: createDeployStatusHandler(siteBinding),
});
export * from '../../../../packages/core/server/functions/mcp.js';
