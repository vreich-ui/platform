/**
 * Admin UI kit barrel (T9.2). Import kit components from `~/components/admin-ui`.
 * Chat-transcript primitives (`ChatThread` and `chat.tsx`'s own, older
 * `ApprovalCard`) are intentionally absent — they land with the chat layout
 * in T9.14. `./approval`'s `ApprovalCard` (T1.2) is a *different*,
 * unrelated-by-import component of the same name for the flat D9 approval
 * surface — `chat.tsx` never imports from this barrel, so the two do not
 * collide, but do not confuse one for the other.
 */
export { cn } from './utils';
export * from './logic';
export * from './icons';
export * from './primitives';
export * from './severity';
export * from './approval';
export * from './forms';
export * from './overlays';
export * from './menus';
export * from './Tree';
export * from './data';
export { AdminShell } from './AdminShell';
export type { AdminShellProps } from './AdminShell';
export { AdminErrorBoundary } from './ErrorBoundary';
export type { AdminErrorBoundaryProps } from './ErrorBoundary';
export { Markdown } from './Markdown';
