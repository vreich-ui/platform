/**
 * Admin kit — menus & navigation (T9.2): Tabs, DropdownMenu, CommandPalette.
 * Each implements its WAI-ARIA Authoring Practices keyboard pattern:
 *   Tabs           — roving tabindex, Arrow/Home/End, aria-selected + tabpanel.
 *   DropdownMenu   — menu button, Arrow navigation, Escape, outside-click close.
 *                    The panel is PORTALED to <body> and positioned `fixed`
 *                    from the trigger's rect: an `absolute` panel inside a
 *                    scroll container (DataTable is `overflow-x-auto`, which
 *                    forces `overflow-y: visible → auto`) counts as scrollable
 *                    overflow, so opening a row menu grew the table and made
 *                    it jump (W18 review, 2026-08-18). Native <dialog> modals
 *                    live in the real top layer and still sit above it.
 *   CommandPalette — combobox+listbox, aria-activedescendant, Arrow/Enter/Esc.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from './utils';
import { filterCommands, type CommandLike } from './logic';
import { Popover, type PopoverTriggerA11yProps } from './overlays';
import { IconSearch } from './icons';

// ─── Tabs ─────────────────────────────────────────────────────────────────────

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, value, defaultValue, onChange, className }: TabsProps) {
  const [internal, setInternal] = useState(defaultValue ?? tabs[0]?.id);
  const active = value ?? internal;
  const baseId = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const setActive = (id: string) => {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  };

  const enabledIds = tabs.filter((t) => !t.disabled).map((t) => t.id);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const currentIndex = enabledIds.indexOf(active);
    let nextId: string | undefined;
    if (event.key === 'ArrowRight') nextId = enabledIds[(currentIndex + 1) % enabledIds.length];
    else if (event.key === 'ArrowLeft') nextId = enabledIds[(currentIndex - 1 + enabledIds.length) % enabledIds.length];
    else if (event.key === 'Home') nextId = enabledIds[0];
    else if (event.key === 'End') nextId = enabledIds[enabledIds.length - 1];
    if (nextId) {
      event.preventDefault();
      setActive(nextId);
      refs.current[nextId]?.focus();
    }
  };

  return (
    <div className={className}>
      <div role="tablist" aria-orientation="horizontal" className="flex gap-1 border-b border-[var(--adm-border)]">
        {tabs.map((tab) => {
          const selected = active === tab.id;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[tab.id] = el;
              }}
              role="tab"
              type="button"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => setActive(tab.id)}
              onKeyDown={onKeyDown}
              className={cn(
                'adm-focusable -mb-px border-b-2 px-3 py-2 text-[length:var(--adm-text-sm)] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                selected
                  ? 'border-[var(--adm-accent)] text-[var(--adm-text)]'
                  : 'border-transparent text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]'
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={active !== tab.id}
          tabIndex={0}
          className="adm-focusable pt-4"
        >
          {active === tab.id ? tab.content : null}
        </div>
      ))}
    </div>
  );
}

// ─── DropdownMenu ─────────────────────────────────────────────────────────────

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  /**
   * Why this item is unavailable (B1/D3). Rendered as a `Popover`
   * (`mode="hover"`) rather than a native `title=` — a `title` on a disabled
   * `<button>` reaches a mouse and nothing else, which is the whole reason
   * `Popover` exists (see `overlays.tsx`). The prop keeps its name so every
   * existing caller reads the same; only what it renders as changed.
   */
  title?: string;
  tone?: 'default' | 'danger';
  separatorBefore?: boolean;
}

export interface DropdownMenuProps {
  trigger: (props: { open: boolean; ref: React.Ref<HTMLButtonElement>; onToggle: () => void }) => ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
  className?: string;
}

/** Fixed-position coordinates for the portaled panel, in viewport space. */
interface MenuPosition {
  top: number;
  left?: number;
  right?: number;
  maxHeight: number;
}

/** Gap between the trigger and the panel, and the margin kept off the viewport edge. */
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

export function DropdownMenu({ trigger, items, align = 'start', className }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const baseId = useId();

  /** Where the menu PARKS on open, and what Home/End mean: an actionable item. */
  const enabledIndexes = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  /**
   * What Up/Down traverse. FIX 7 — this now includes DISABLED items, because
   * they render as `aria-disabled` menuitems (focusable, and refused by
   * `select`) rather than as unfocusable `disabled` buttons.
   *
   * That is what makes convention D3 true here rather than merely intended:
   * a disabled item's reason opens on FOCUS (`Popover mode="hover"` arms on
   * `trigger-focus`, not only on pointer enter), so arrowing onto "Archive"
   * announces "Ask an owner". Skipping them, as this did, left the reason
   * reachable by a mouse and nothing else — the exact failure the Popover
   * was built to end.
   */
  const navigableIndexes = items.map((_, i) => i);

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const first = enabledIndexes[0] ?? 0;
    setActiveIndex(first);
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is portaled out of `rootRef`, so it must be tested separately.
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  /**
   * Place the panel from the trigger's viewport rect, flipping above the
   * trigger when there is more room there. Measured AFTER paint (the panel is
   * rendered off-screen for one frame at `top: -9999` so its height is real).
   */
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const panelHeight = menuRef.current?.offsetHeight ?? 0;
      const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
      const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
      const flip = panelHeight > below && above > below;
      setPosition({
        top: flip ? Math.max(VIEWPORT_MARGIN, rect.top - MENU_GAP - panelHeight) : rect.bottom + MENU_GAP,
        ...(align === 'end'
          ? { right: Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right) }
          : { left: Math.max(VIEWPORT_MARGIN, rect.left) }),
        maxHeight: Math.max(120, flip ? above : below),
      });
    };
    place();
    // A fixed panel does not travel with its trigger — close rather than drift.
    const dismiss = () => setOpen(false);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open, align, items.length]);

  const move = (dir: 1 | -1) => {
    if (navigableIndexes.length === 0) return;
    const pos = navigableIndexes.indexOf(activeIndex);
    const nextPos = (pos + dir + navigableIndexes.length) % navigableIndexes.length;
    setActiveIndex(navigableIndexes[nextPos]);
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      // Home/End go to an ACTIONABLE item — arrowing is how you inspect a
      // disabled one's reason. A menu with nothing actionable in it keeps
      // whatever is focused rather than jumping to `undefined`.
      if (enabledIndexes.length > 0) setActiveIndex(enabledIndexes[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      if (enabledIndexes.length > 0) setActiveIndex(enabledIndexes[enabledIndexes.length - 1]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    item.onSelect?.();
    close();
  };

  /**
   * One menu item. `a11y` is `Popover`'s render-prop payload, and it lands on
   * the element that actually TAKES FOCUS, so the tooltip is that element's
   * own `aria-describedby`.
   *
   * FIX 7 — a disabled item renders as an `aria-disabled` span, not a
   * `disabled` <button>.
   *
   * A `disabled` <button> is not focusable, so this menu's roving-tabindex
   * model (`itemRefs.current[activeIndex].focus()`) could never reach one,
   * and it fires no pointer or focus events, so its reason was unreachable
   * too. `Popover`'s `disabled` mode papered over the second half by adding
   * a `tabIndex={0}` wrapper span — but that span is not a `menuitem` and is
   * not in `itemRefs`, so inside `role="menu"` it became a stray Tab stop
   * that arrow keys could not reach and screen readers could not name.
   *
   * `aria-disabled` is the ARIA-recommended spelling inside a menu for
   * exactly this reason: the item stays focusable and stays in the roving
   * model, while still announcing as unavailable. `select()` already
   * refuses a disabled item, and `enabledIndexes` already excludes it from
   * arrow-key traversal, so nothing here can be actioned by accident.
   *
   * That also lets `Popover` stay in its ordinary enabled-trigger mode here
   * — no wrapper tab stop at all — which keeps the component honest for its
   * other callers rather than growing a menu-shaped exception.
   */
  const renderItem = (item: MenuItem, index: number, a11y: PopoverTriggerA11yProps = {}) => {
    const className = cn(
      'adm-focusable flex w-full items-center gap-2 rounded-[var(--adm-radius-sm)] px-2.5 py-1.5 text-left text-[length:var(--adm-text-sm)]',
      item.disabled ? 'cursor-not-allowed opacity-40' : '',
      item.tone === 'danger' ? 'text-[var(--adm-danger)]' : 'text-[var(--adm-text)]',
      index === activeIndex && !item.disabled
        ? item.tone === 'danger'
          ? 'bg-[var(--adm-danger-soft)]'
          : 'bg-[var(--adm-accent-soft)]'
        : ''
    );
    const body = (
      <>
        {item.icon ? <span className="shrink-0">{item.icon}</span> : null}
        {item.label}
      </>
    );
    if (item.disabled) {
      return (
        <span
          ref={(el) => {
            itemRefs.current[index] = el;
          }}
          role="menuitem"
          aria-disabled="true"
          // Focusable, so the reason is reachable — but never the menu's
          // default stop, which `enabledIndexes` keeps on an actionable item.
          tabIndex={-1}
          {...a11y}
          className={className}
        >
          {body}
        </span>
      );
    }
    return (
      <button
        ref={(el) => {
          itemRefs.current[index] = el;
        }}
        role="menuitem"
        type="button"
        tabIndex={index === activeIndex ? 0 : -1}
        onClick={() => select(item)}
        onMouseEnter={() => setActiveIndex(index)}
        {...a11y}
        className={className}
      >
        {body}
      </button>
    );
  };

  const panel = (
    <div
      ref={menuRef}
      role="menu"
      aria-orientation="vertical"
      id={`${baseId}-menu`}
      onKeyDown={onMenuKeyDown}
      style={
        position
          ? { top: position.top, left: position.left, right: position.right, maxHeight: position.maxHeight }
          : // First paint: off-screen so the panel can be measured without a
            // flash. `opacity` (not `visibility`) — a visibility:hidden panel
            // is not focusable, and the open effect focuses its first item.
            { top: 0, left: 0, opacity: 0 }
      }
      className={cn(
        'adm-root adm-animate-in fixed z-[55] min-w-[12rem] overflow-y-auto rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] p-1 shadow-[var(--adm-shadow-md)]'
      )}
    >
      {items.map((item, index) => (
        <div key={item.id} className={item.separatorBefore ? 'mt-1 border-t border-[var(--adm-border)] pt-1' : ''}>
          {item.title ? (
            /* D3: the reason an item is unavailable must be reachable by
               keyboard and touch, not only by a mouse resting on a native
               `title`. No `disabled` prop here — `renderItem` gives a
               disabled item an `aria-disabled` span, which fires its own
               pointer and focus events, so Popover needs no wrapper tab stop
               inside this menu (FIX 7). */
            <Popover
              mode="hover"
              placement="top"
              className="w-full"
              content={item.title}
              trigger={(a11y) => renderItem(item, index, a11y)}
            />
          ) : (
            renderItem(item, index)
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div ref={rootRef} className={cn('relative inline-block', className)}>
      {trigger({
        open,
        ref: triggerRef,
        onToggle: () => setOpen((o) => !o),
      })}
      {open && typeof document !== 'undefined' ? createPortal(panel, document.body) : null}
    </div>
  );
}

// ─── CommandPalette ───────────────────────────────────────────────────────────

export interface CommandItem extends CommandLike {
  onSelect?: () => void;
  icon?: ReactNode;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
  placeholder?: string;
  onSelect?: (command: CommandItem) => void;
}

export function CommandPalette({
  open,
  onClose,
  commands,
  placeholder = 'Type a command…',
  onSelect,
}: CommandPaletteProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const baseId = useId();

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      setQuery('');
      setActiveIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleClose = () => onClose();
    el.addEventListener('close', handleClose);
    return () => el.removeEventListener('close', handleClose);
  }, [onClose]);

  useEffect(() => setActiveIndex(0), [query]);

  const choose = (command: CommandItem | undefined) => {
    if (!command) return;
    command.onSelect?.();
    onSelect?.(command);
    ref.current?.close();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(results[activeIndex]);
    }
    // Escape is handled natively by <dialog> → 'close' → onClose.
  };

  return (
    <dialog
      ref={ref}
      className="adm-dialog adm-root adm-animate-in mx-auto mt-[12vh] w-[calc(100vw-2rem)] max-w-xl rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] p-0 text-[var(--adm-text)] shadow-[var(--adm-shadow-lg)]"
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--adm-border)] px-3">
        <IconSearch size={18} className="text-[var(--adm-text-muted)]" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={true}
          aria-controls={`${baseId}-listbox`}
          aria-activedescendant={results[activeIndex] ? `${baseId}-opt-${results[activeIndex].id}` : undefined}
          aria-autocomplete="list"
          placeholder={placeholder}
          className="h-12 flex-1 bg-transparent text-[length:var(--adm-text-base)] text-[var(--adm-text)] outline-none placeholder:text-[var(--adm-text-muted)]"
        />
      </div>
      <ul id={`${baseId}-listbox`} role="listbox" className="max-h-80 overflow-auto p-1">
        {results.length === 0 ? (
          <li className="px-3 py-6 text-center text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            No matching commands
          </li>
        ) : (
          results.map((command, index) => (
            <li
              key={command.id}
              id={`${baseId}-opt-${command.id}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(command)}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-2 rounded-[var(--adm-radius-sm)] px-3 py-2 text-[length:var(--adm-text-sm)]',
                index === activeIndex ? 'bg-[var(--adm-accent-soft)] text-[var(--adm-text)]' : 'text-[var(--adm-text)]'
              )}
            >
              <span className="flex items-center gap-2">
                {command.icon ? <span className="shrink-0 text-[var(--adm-text-muted)]">{command.icon}</span> : null}
                {command.label}
              </span>
              {command.group ? (
                <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{command.group}</span>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </dialog>
  );
}
