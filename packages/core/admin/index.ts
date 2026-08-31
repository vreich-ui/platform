/**
 * Admin UI kit barrel (T9.2). Import kit components from `~/components/admin-ui`.
 *
 * Chat-transcript primitives (`ChatThread`, `ChatComposer`, `ToolCallCard`,
 * `chat.tsx`) are intentionally absent — they landed with the chat layout in
 * T9.14 and `chat.tsx` still does not import from this barrel; it reaches
 * `./approval` directly.
 *
 * There is exactly ONE `ApprovalCard`: `./approval`'s (T1.2), the flat D9
 * approval surface. A7 deleted `chat.tsx`'s own, older component of the same
 * name and moved the chat's pending tool-call onto this one, so the
 * two-different-components-one-name hazard this comment used to warn about no
 * longer exists — there is nothing left to confuse it with.
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
