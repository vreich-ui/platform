import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { IconChevronRight } from './icons';
import { cn } from './utils';

export interface TreeNode {
  id: string;
  label: ReactNode;
  children?: TreeNode[];
  href?: string;
  badge?: ReactNode;
}

export interface TreeProps {
  nodes: TreeNode[];
  activeId?: string;
  /** Used only when no saved expansion preference exists. */
  defaultExpandedIds?: string[];
  onSelect?: (id: string) => void;
  ariaLabel: string;
  storageKey?: string;
}

interface VisibleNode {
  node: TreeNode;
  level: number;
  parentId?: string;
}

export function flattenVisibleTree(
  nodes: TreeNode[],
  expanded: Set<string>,
  level = 1,
  parentId?: string
): VisibleNode[] {
  const rows: VisibleNode[] = [];
  for (const node of nodes) {
    rows.push({ node, level, parentId });
    if (node.children?.length && expanded.has(node.id)) {
      rows.push(...flattenVisibleTree(node.children, expanded, level + 1, node.id));
    }
  }
  return rows;
}

function expandableIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => (node.children?.length ? [node.id, ...expandableIds(node.children)] : []));
}

export function Tree({ nodes, activeId, defaultExpandedIds, onSelect, ariaLabel, storageKey }: TreeProps) {
  const key = `platform:admin:tree:${storageKey ?? ariaLabel.toLowerCase().replace(/\W+/g, '-')}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpandedIds ?? expandableIds(nodes)));
  const [focusedId, setFocusedId] = useState(activeId ?? nodes[0]?.id);
  const refs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
      if (saved.length) setExpanded(new Set(saved));
    } catch {
      // Invalid preference data is harmless; use the default open groups.
    }
  }, [key]);

  const visible = useMemo(() => flattenVisibleTree(nodes, expanded), [nodes, expanded]);
  const toggle = (id: string) => {
    setExpanded((prior) => {
      const next = new Set(prior);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(key, JSON.stringify([...next]));
      return next;
    });
  };
  const focus = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    requestAnimationFrame(() => refs.current[id]?.focus());
  };

  const onKeyDown = (event: React.KeyboardEvent, row: VisibleNode, index: number) => {
    const hasChildren = Boolean(row.node.children?.length);
    if (event.key === 'ArrowDown') focus(visible[index + 1]?.node.id);
    else if (event.key === 'ArrowUp') focus(visible[index - 1]?.node.id);
    else if (event.key === 'Home') focus(visible[0]?.node.id);
    else if (event.key === 'End') focus(visible.at(-1)?.node.id);
    else if (event.key === 'ArrowRight' && hasChildren) {
      if (!expanded.has(row.node.id)) toggle(row.node.id);
      else focus(row.node.children?.[0]?.id);
    } else if (event.key === 'ArrowLeft') {
      if (hasChildren && expanded.has(row.node.id)) toggle(row.node.id);
      else focus(row.parentId);
    } else return;
    event.preventDefault();
  };

  return (
    <div role="tree" aria-label={ariaLabel} className="flex flex-col gap-0.5">
      {visible.map((row, index) => {
        const selected = row.node.id === activeId;
        const open = expanded.has(row.node.id);
        const hasChildren = Boolean(row.node.children?.length);
        const common = cn(
          'adm-focusable flex min-h-8 w-full items-center gap-1.5 rounded-[var(--adm-radius-sm)] py-1 pr-2 text-left text-[length:var(--adm-text-sm)]',
          selected
            ? 'bg-[var(--adm-accent-soft)] font-medium text-[var(--adm-accent)]'
            : 'text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]'
        );
        const content = (
          <>
            <span className="grid h-4 w-4 shrink-0 place-items-center">
              {hasChildren ? (
                <IconChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
              ) : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{row.node.label}</span>
            {row.node.badge}
          </>
        );
        const props = {
          ref: (element: HTMLElement | null) => {
            refs.current[row.node.id] = element;
          },
          role: 'treeitem',
          'aria-level': row.level,
          'aria-selected': selected,
          'aria-expanded': hasChildren ? open : undefined,
          tabIndex: row.node.id === focusedId ? 0 : -1,
          onFocus: () => setFocusedId(row.node.id),
          onKeyDown: (event: React.KeyboardEvent) => onKeyDown(event, row, index),
          className: common,
          style: { paddingLeft: `${(row.level - 1) * 14 + 6}px` },
        };
        return row.node.href ? (
          <a {...props} key={row.node.id} href={row.node.href} onClick={() => onSelect?.(row.node.id)}>
            {content}
          </a>
        ) : (
          <button
            {...props}
            key={row.node.id}
            type="button"
            onClick={() => {
              if (hasChildren) toggle(row.node.id);
              onSelect?.(row.node.id);
            }}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
