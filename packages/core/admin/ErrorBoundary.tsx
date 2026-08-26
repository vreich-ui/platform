/**
 * AdminErrorBoundary (P0 follow-up, 2026-08-06) — catches render errors
 * anywhere below it in the React tree so one broken admin surface degrades
 * to a readable message instead of a blank page. This is what should have
 * turned the MaintenancePage `#31` crash ("Objects are not valid as a React
 * child") into a visible fallback instead of an empty `<main>`.
 *
 * Must be a class component: `getDerivedStateFromError` /
 * `componentDidCatch` have no hook equivalent (React docs) — a boundary
 * cannot be written as a function component.
 *
 * Placement: this mounts inside AdminShell (wrapping `children`), NOT in
 * AdminLayout.astro. Verified empirically before choosing this: each page's
 * `<Foo client:load />` in an .astro file becomes its own independent React
 * root (an astro-island). Wrapping the Astro `<slot />` only wraps inert
 * server-rendered HTML at the Astro-template level; that markup is never a
 * parent of the island's React tree, so a boundary placed there cannot
 * receive that tree's thrown errors — React only propagates a render error
 * up through actual React parents, and AdminLayout.astro and the island's
 * React tree are not in the same tree at all. AdminShell is the one
 * component every admin page already mounts as the root of its own island
 * (see every `export default function XPage()` in this directory), so a
 * boundary there sits inside every page's real React tree while still
 * leaving the sidebar/topbar chrome outside it — a crash below AdminShell's
 * `{children}` shouldn't take the nav down with it.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { Button, Card, EmptyState } from './primitives';

export interface AdminErrorBoundaryProps {
  /** Human label for the guarded surface (e.g. "Maintenance") — shown in the fallback so an operator knows what broke. */
  surface: string;
  children: ReactNode;
}

interface AdminErrorBoundaryState {
  error: Error | null;
}

export class AdminErrorBoundary extends Component<AdminErrorBoundaryProps, AdminErrorBoundaryState> {
  state: AdminErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AdminErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The fallback below deliberately shows a human summary, not the stack —
    // this console.error is what keeps the real error debuggable.
    console.error(`[admin] "${this.props.surface}" crashed while rendering:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Card>
        <EmptyState
          severity="error"
          title={`"${this.props.surface}" hit an error`}
          message={error.message || 'Something went wrong rendering this page.'}
          action={
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        />
      </Card>
    );
  }
}
