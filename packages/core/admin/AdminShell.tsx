/**
 * AdminShell (T9.3) — the workspace frame: sidebar, topbar with user chip,
 * Cmd-K command palette, and a Toast provider. This is a shared React *layout
 * component*, not an island: each admin page mounts a single island that
 * renders its content as `children` inside this shell, so the whole page
 * (shell chrome + page widgets) lives in one React tree and shares the Toast
 * context and palette.
 *
 * The "Legacy" group (publish/drafts/agent-admin/library/blobs) retired in
 * W9.g (T9.24) — every capability now lives on the surfaces below.
 */
// D2: identity is resolved server-side (Astro frontmatter, where
// process.env is real) and threaded down as a prop — see the admin route
// .astro files and page components. getSiteIdentity() must never be called
// from this client:load island; that would silently drop any env override.
import type { SiteIdentity } from '../lib/site-identity.js';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from './utils';
import { Avatar, Badge, IconButton } from './primitives';
import { CommandPalette, DropdownMenu, type CommandItem } from './menus';
import { ToastProvider, useToast } from './overlays';
import { Drawer } from './overlays';
import { AdminErrorBoundary } from './ErrorBoundary';
import {
  IconHome,
  IconLibrary,
  IconSparkles,
  IconPalette,
  IconSettings,
  IconUser,
  IconWrench,
  IconMenu,
  IconLogout,
  IconSearch,
  IconRocket,
  IconClock,
  IconExternalLink,
  type IconProps,
} from './icons';
import { objectTypeLabel } from '@core/lib/admin/display-name';
import type { LibraryRow } from '@core/lib/admin/library-logic';
import { avatarSrc } from '@core/lib/admin/users-client';
import { useCurrentUser } from '@core/lib/admin/use-current-user';
import { welcomeGateDecision } from './logic';
import { listRequests } from '@core/lib/admin/requests-client';
import { summarizeRequestRows } from '@core/lib/admin/request-logic';
import { useRequestNotifications } from './useRequestNotifications';
import { ADMIN_COMPACT_NAV_CLASS, ADMIN_EXPANDED_NAV_CLASS } from '@core/lib/admin/responsive-workspace';
import { settingsNavigationLabel } from '@core/lib/admin/admin-navigation';

async function shellToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

interface NavItem {
  label: string;
  href: string;
  icon: (p: IconProps) => ReactNode;
  soon?: boolean;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
  ownerOnly?: boolean;
}

// Target IA (plan §2). Routes not yet built are marked `soon` — shown but not
// linked — so the sidebar reflects the destination without dead links.
export const NAV: NavGroup[] = [
  {
    items: [
      { label: 'Editorial', href: '/admin', icon: IconHome },
      { label: 'Requests', href: '/admin/requests', icon: IconClock },
      { label: 'Templates', href: '/admin/templates', icon: IconPalette },
      { label: 'Media', href: '/admin/media', icon: IconLibrary },
      { label: 'Content', href: '/admin/content', icon: IconLibrary },
      { label: 'Release', href: '/admin/release', icon: IconRocket },
    ],
  },
  {
    label: 'Settings',
    ownerOnly: true,
    items: [
      { label: 'Visual identity', href: '/admin/settings/visual-identity', icon: IconPalette },
      { label: 'Guardrails', href: '/admin/settings/guardrails', icon: IconSettings },
      { label: 'Admins', href: '/admin/settings/admins', icon: IconUser },
      { label: 'Profile', href: '/admin/profile', icon: IconUser },
      { label: 'Maintenance', href: '/admin/maintenance', icon: IconWrench },
      { label: 'Component kit', href: '/admin/kit', icon: IconLibrary },
      { label: 'Agents', href: '/admin/agents', icon: IconSparkles },
    ],
  },
];

function isActive(currentPath: string, href: string): boolean {
  if (href === '/admin') return currentPath === '/admin' || currentPath === '/admin/';
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

function NavList({
  currentPath,
  owner,
  settingsLabel,
  onNavigate,
}: {
  currentPath: string;
  owner: boolean;
  settingsLabel: string;
  onNavigate?: () => void;
}) {
  const groups = NAV.filter((group) => !group.ownerOnly || owner);
  return (
    <nav className="flex flex-col gap-5" aria-label="Admin sections">
      {groups.map((group, gi) => (
        <div key={group.label ?? `group-${gi}`} className="flex flex-col gap-1">
          {group.label ? (
            <p className="px-3 pb-1 text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
              {group.label === 'Settings' ? settingsLabel : group.label}
            </p>
          ) : null}
          {group.items.map((item) => {
            const active = isActive(currentPath, item.href);
            const Icon = item.icon;
            const inner = (
              <>
                <Icon size={18} />
                <span className="flex-1">{item.label}</span>
                {item.soon ? (
                  <span className="rounded-[var(--adm-radius-pill)] bg-[var(--adm-surface-sunken)] px-1.5 py-0.5 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text-muted)]">
                    soon
                  </span>
                ) : null}
              </>
            );
            const base =
              'flex items-center gap-2.5 rounded-[var(--adm-radius-md)] px-3 py-2 text-[length:var(--adm-text-sm)]';
            if (item.soon) {
              return (
                <span
                  key={item.href}
                  aria-disabled="true"
                  className={cn(base, 'cursor-not-allowed text-[var(--adm-text-muted)] opacity-70')}
                >
                  {inner}
                </span>
              );
            }
            return (
              <a
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  base,
                  'adm-focusable font-medium transition-colors',
                  active
                    ? 'bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]'
                    : 'text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]'
                )}
              >
                {inner}
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/**
 * W19: the one poll behind the shell's pills, the toasts, the browser
 * notification and the tab-title count.
 *
 * It is a CHILD of `ToastProvider` rather than part of `AdminShell`'s body
 * because the shell renders that provider and cannot consume its own context.
 * Rendering nothing is the point: it exists to own the interval exactly once
 * per page, so no two surfaces can announce the same transition.
 */
function RequestPulse({
  onCounts,
  onUnread,
}: {
  onCounts: (counts: { working: number; needsYou: number; stalled: number }) => void;
  onUnread: (unread: number) => void;
}) {
  const { toast } = useToast();
  const { ingest, unread, clearUnread } = useRequestNotifications(shellToken, toast);

  useEffect(() => {
    onUnread(unread);
  }, [unread, onUnread]);

  // Visiting the requests surface IS reading them.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.pathname.startsWith('/admin/requests')) clearUnread();
  }, [clearUnread]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        // W19 T19.2: ONE blob GET (the request index), not the O(N) chat scan
        // this used to run every 15 s per signed-in admin (plan F7).
        const result = await listRequests(shellToken, { limit: 100 });
        if (!alive) return;
        onCounts(summarizeRequestRows(result.requests));
        ingest(result.requests, result.last_notified ?? {}, result.muted ?? []);
      } catch {
        // Global utilities are progressive enhancement; page work remains usable.
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [ingest, onCounts]);

  return null;
}

export interface AdminShellProps {
  currentPath: string;
  title?: string;
  /** Server-resolved site identity (D2) — every page component must pass this through. */
  identity: SiteIdentity;
  children: ReactNode;
  wide?: boolean;
}

export function AdminShell({ currentPath, title, identity, children, wide = false }: AdminShellProps) {
  const currentUser = useCurrentUser();
  const user = currentUser.user;
  const owner = currentUser.roles.includes('owner') || user?.role === 'owner';
  const [mobileNav, setMobileNav] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [objectRows, setObjectRows] = useState<LibraryRow[]>([]);
  const [workCounts, setWorkCounts] = useState({ working: 0, needsYou: 0, stalled: 0 });
  const [, setUnread] = useState(0);
  const objectsAttempted = useRef(false);

  // W18 T18.5: the welcome gate. A member whose Person.onboarding is not
  // completed (new invitee, Netlify-UI grant, first-time bootstrap Owner) is
  // sent to /admin/welcome once, unless the policy turns the name gate off.
  // `?skip_welcome=1` (Owner override) stamps completion and stays put.
  // Pure decision: welcomeGateDecision (logic.ts). Never fires on the exempt
  // pages, never for a caller without roles (the layout's forbidden panel).
  useEffect(() => {
    if (currentUser.loading || typeof window === 'undefined') return;
    if (currentUser.onboarding === undefined) return; // an older server without the field — no gate
    const params = new URLSearchParams(window.location.search);
    if (
      params.get('skip_welcome') === '1' &&
      currentUser.roles.length > 0 &&
      currentUser.onboarding &&
      !currentUser.onboarding.completed_at
    ) {
      import('@core/lib/admin/users-client')
        .then((m) => m.updateMe(shellToken, { onboarding_step: 'skipped' }))
        .catch(() => undefined);
      return;
    }
    const decision = welcomeGateDecision({
      path: window.location.pathname,
      roles: currentUser.roles,
      hasRecord: currentUser.onboarding !== null,
      completed: Boolean(currentUser.onboarding?.completed_at),
      requireDisplayName: currentUser.requireDisplayName ?? true,
    });
    if (decision === 'redirect') window.location.replace('/admin/welcome');
  }, [currentUser.loading, currentUser.onboarding, currentUser.roles, currentUser.requireDisplayName]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Lazy-load the object list the first time the palette opens so Cmd-K can
  // fuzzy-find any object by its human display name (T9.8).
  useEffect(() => {
    if (!paletteOpen || objectsAttempted.current) return;
    objectsAttempted.current = true;
    let alive = true;
    (async () => {
      try {
        const { fetchInventoryRows } = await import('@core/lib/admin/library-client');
        const rows = await fetchInventoryRows(shellToken);
        if (alive) setObjectRows(rows);
      } catch {
        // palette still works for nav/actions without the object list
      }
    })();
    return () => {
      alive = false;
    };
  }, [paletteOpen]);

  const onLogout = () => {
    import('@core/lib/admin/goTrueClient')
      .then((m) => m.logout())
      .then(() => window.dispatchEvent(new CustomEvent('cms:logout')))
      .catch(() => {})
      .finally(() => window.location.assign('/admin'));
  };

  const navCommands: CommandItem[] = NAV.filter((group) => !group.ownerOnly || owner).flatMap((group) =>
    group.items
      .filter((item) => !item.soon)
      .map((item) => ({
        id: item.href,
        label: item.label,
        group: group.label ?? 'Go to',
        onSelect: () => window.location.assign(item.href),
      }))
  );

  const actionCommands: CommandItem[] = [
    {
      id: 'action-release',
      label: 'Release to production',
      group: 'Actions',
      icon: <IconRocket size={16} />,
      onSelect: () => window.location.assign('/admin/release'),
    },
  ];

  const objectCommands: CommandItem[] = objectRows.map((row) => ({
    id: `object-${row.object_id}`,
    label: row.display_name,
    group: objectTypeLabel(row.object_type),
    keywords: [row.object_id, row.object_type],
    onSelect: () =>
      window.location.assign(`/admin/content/${encodeURIComponent(row.object_id)}?type=${row.object_type}`),
  }));

  const commands: CommandItem[] = [...actionCommands, ...navCommands, ...objectCommands];

  return (
    <ToastProvider>
      <RequestPulse onCounts={setWorkCounts} onUnread={setUnread} />
      <div className="adm-root flex min-h-screen bg-[var(--adm-surface-page)] text-[var(--adm-text)]">
        {/* Sidebar (desktop) */}
        <aside
          className={cn(
            'sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[var(--adm-border)] bg-[var(--adm-surface)] p-4',
            ADMIN_EXPANDED_NAV_CLASS
          )}
        >
          <a href="/admin" className="adm-focusable mb-6 flex items-center gap-2 rounded px-1">
            <span className="grid h-7 w-7 place-items-center rounded-[var(--adm-radius-md)] bg-[var(--adm-accent)] text-[length:var(--adm-text-sm)] font-bold text-[var(--adm-text-on-accent)]">
              L
            </span>
            <span className="text-[length:var(--adm-text-sm)] font-semibold text-[var(--adm-text-heading)]">
              {identity.adminLabel}
            </span>
          </a>
          <NavList
            currentPath={currentPath}
            owner={owner}
            settingsLabel={settingsNavigationLabel(identity.brandName)}
          />
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            className="adm-focusable mt-auto flex items-center gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] px-3 py-2 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
          >
            <IconExternalLink size={16} />
            View publication
          </a>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Topbar */}
          <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-[var(--adm-border)] bg-[var(--adm-surface)] px-4 py-3">
            <IconButton
              label="Open navigation"
              icon={<IconMenu size={20} />}
              className={ADMIN_COMPACT_NAV_CLASS}
              onClick={() => setMobileNav(true)}
            />
            <h1 className="flex-1 truncate text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
              {title ?? 'Workspace'}
            </h1>
            {/* W19: the three pills deep-link to the matching /admin/requests
                filter — they used to point at /admin/release, which is not a
                request list. */}
            {workCounts.working > 0 ? (
              <a
                href="/admin/requests?status=running%2Cqueued"
                className="adm-focusable hidden rounded-[var(--adm-radius-pill)] bg-[var(--adm-info-soft)] px-2.5 py-1 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-info-text)] sm:inline-flex"
              >
                Working · {workCounts.working}
              </a>
            ) : null}
            {workCounts.needsYou > 0 ? (
              <a
                href="/admin/requests?status=needs_you"
                className="adm-focusable hidden rounded-[var(--adm-radius-pill)] bg-[var(--adm-warning-soft)] px-2.5 py-1 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-warning-text)] sm:inline-flex"
              >
                Needs you · {workCounts.needsYou}
              </a>
            ) : null}
            {workCounts.stalled > 0 ? (
              <a
                href="/admin/requests?status=stalled%2Cfailed"
                className="adm-focusable hidden rounded-[var(--adm-radius-pill)] bg-[var(--adm-danger-soft)] px-2.5 py-1 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-danger-text)] sm:inline-flex"
              >
                Stalled · {workCounts.stalled}
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="adm-focusable hidden items-center gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] px-2.5 py-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)] sm:flex"
            >
              <IconSearch size={16} />
              Search
              <kbd className="rounded bg-[var(--adm-surface-sunken)] px-1 text-[length:var(--adm-text-xs)]">⌘K</kbd>
            </button>
            <a
              href="/"
              target="_blank"
              rel="noreferrer"
              className="adm-focusable hidden items-center gap-1.5 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] px-2.5 py-1.5 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)] lg:flex"
            >
              View publication <IconExternalLink size={14} />
            </a>
            {user ? (
              <DropdownMenu
                align="end"
                trigger={({ ref, onToggle, open }) => (
                  <button
                    ref={ref}
                    type="button"
                    onClick={onToggle}
                    aria-expanded={open}
                    className="adm-focusable flex items-center gap-2 rounded-[var(--adm-radius-md)] px-2 py-1 hover:bg-[var(--adm-surface-sunken)]"
                  >
                    {avatarSrc(user.avatar_artifact) ? (
                      <img
                        src={avatarSrc(user.avatar_artifact)}
                        alt=""
                        className="h-[30px] w-[30px] rounded-full object-cover"
                      />
                    ) : (
                      <Avatar name={user.display_name || user.email} size={30} />
                    )}
                    <span className="hidden max-w-[10rem] truncate text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] lg:inline">
                      {user.display_name || user.email}
                    </span>
                    <Badge tone={owner ? 'accent' : 'neutral'}>{owner ? 'Owner' : 'Admin'}</Badge>
                  </button>
                )}
                items={[
                  { id: 'identity', label: user.email, disabled: true, title: user.email },
                  {
                    id: 'profile',
                    label: 'Profile',
                    icon: <IconUser size={16} />,
                    onSelect: () => window.location.assign('/admin/profile'),
                  },
                  ...(owner
                    ? [
                        {
                          id: 'settings',
                          label: 'Settings',
                          icon: <IconSettings size={16} />,
                          onSelect: () => window.location.assign('/admin/settings/admins'),
                        },
                      ]
                    : []),
                  {
                    id: 'logout',
                    label: 'Sign out',
                    icon: <IconLogout size={16} />,
                    separatorBefore: true,
                    tone: 'danger' as const,
                    onSelect: onLogout,
                  },
                ]}
              />
            ) : null}
          </header>

          <main className={cn('mx-auto w-full flex-1 p-4 sm:p-6', wide ? 'max-w-none' : 'max-w-6xl')}>
            {/*
              Every admin page mounts AdminShell as the root of its own
              client:load island (see MaintenancePage.tsx et al.), so this is
              the one place a boundary sits inside every page's real React
              tree — an Astro-level wrapper around the island's <slot />
              cannot see a React throw in a separate hydration root (see
              ErrorBoundary.tsx). Scoped to `children` only, so a crash in
              the page body degrades to a fallback without taking the
              sidebar/topbar chrome (and its sign-out / nav) down with it.
            */}
            <AdminErrorBoundary surface={title ?? 'Workspace'}>{children}</AdminErrorBoundary>
          </main>
        </div>

        {/* Sidebar (mobile drawer) */}
        <Drawer
          open={mobileNav}
          onClose={() => setMobileNav(false)}
          title={identity.adminLabel}
          side="left"
          width={280}
        >
          <NavList
            currentPath={currentPath}
            owner={owner}
            settingsLabel={settingsNavigationLabel(identity.brandName)}
            onNavigate={() => setMobileNav(false)}
          />
        </Drawer>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          commands={commands}
          placeholder="Go to…"
        />
      </div>
    </ToastProvider>
  );
}
