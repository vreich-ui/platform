/**
 * The admin shell's own 404 (`/admin/not-found`).
 *
 * Before this, any unmatched `/admin/*` path fell through to the PUBLIC
 * site's 404 page object: all admin chrome gone, no sidebar, no way back
 * except retyping a URL — and the public header rendering "Sign in" to
 * someone holding a live Owner session. A mistyped or half-remembered admin
 * address (`/admin/visual-identity` for `/admin/settings/visual-identity`)
 * was enough to eject an operator from the workspace (`site_zilberman`,
 * 2026-09-13).
 *
 * A tenant's `netlify.toml` sends unmatched `/admin/*` here with a real 404
 * status. Non-forced, so it fires only where nothing else matched: every real
 * admin page is a static file or an earlier rewrite, and both win.
 *
 * THIN, on purpose: the value is the shell around it, not this page. The
 * sidebar is the way back, so nothing here re-lists the navigation.
 */
import { AdminShell } from './AdminShell';
import { Button, Card, EmptyState } from './primitives';
import type { SiteIdentity } from '@core/lib/site-identity';

export interface AdminNotFoundProps {
  identity: SiteIdentity;
}

export default function AdminNotFound({ identity }: AdminNotFoundProps) {
  // Read at render rather than server-side: the rewrite serves this ONE page
  // for every unmatched path, so the address the person actually typed only
  // exists in the browser. Empty during SSR, which is correct — the sentence
  // reads fine without it.
  const attempted = typeof window === 'undefined' ? '' : window.location.pathname;
  return (
    <AdminShell currentPath="/admin/not-found" title="Not found" identity={identity}>
      <Card kicker="Admin" title="That admin page does not exist">
        <EmptyState
          severity="info"
          title={attempted ? `Nothing is served at ${attempted}` : 'Nothing is served at that address'}
          message="The address may have changed, or been mistyped. Your session is untouched — pick a section from the sidebar, or go back to the runs inbox."
          action={
            <Button onClick={() => window.location.assign('/admin/requests')}>Back to Requests</Button>
          }
        />
      </Card>
    </AdminShell>
  );
}
