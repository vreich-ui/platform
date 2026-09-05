/**
 * T21.9b — compatibility shim. The dashboard is now `admin-analytics`
 * (`/admin/analytics`, `.netlify/functions/admin-analytics`); this file keeps
 * the OLD function URL (`/.netlify/functions/admin-traffic`) answering for one
 * wave so nothing that already bookmarked or cached the old path breaks
 * mid-rollout. New callers should use `admin-analytics`. Remove this file
 * once the old path has had a full deploy cycle with no traffic.
 */
export { handler } from './admin-analytics.js';
