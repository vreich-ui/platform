/**
 * Dr. Lurie's complete MCP sibling set.
 *
 * Every Netlify function is an isolated process. Any Dr. Lurie entry point
 * that exposes or executes the MCP tool surface must call this bootstrap so
 * `verify_article_images` is present consistently in direct MCP discovery,
 * plugin manifests, the Actions facade, and admin-chat execution.
 */
import { configureMcp } from '../../packages/core/server/functions/mcp.js';
import { createHandler as createDeployStatusHandler } from '../../packages/core/server/functions/deploy-status.js';
import { createHandler as createObjectStoreHandler } from '../../packages/core/server/functions/object-store.js';
import { createHandler as createSaveArtifactHandler } from '../../packages/core/server/functions/save-artifact.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';
import { handler as verifyArticleImagesHandler } from '../functions/verify-article-images.js';

export const configureDrlurieMcpSiblings = (): void => {
  configureMcp({
    binding: drlurieSiteBinding,
    saveArtifactHandler: createSaveArtifactHandler(drlurieSiteBinding),
    objectStoreHandler: createObjectStoreHandler(drlurieSiteBinding),
    deployStatusHandler: createDeployStatusHandler(drlurieSiteBinding),
    verifyArticleImagesHandler,
  });
};
