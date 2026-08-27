import { useEffect, useMemo, useState } from 'react';

import { Input } from './forms';
import { Badge, Skeleton } from './primitives';
import { Tree, type TreeNode } from './Tree';
import { objectTypeLabel } from '@core/lib/admin/display-name';
import { fetchInventoryRows } from '@core/lib/admin/library-client';
import { filterRows, rowStatus, type LibraryRow } from '@core/lib/admin/library-logic';
import { fetchReleaseOverview } from '@core/lib/admin/release-client';
import { listChats, type ChatSummaryView } from '@core/lib/admin/chat-client';
import { EDITORIAL_STATE_PRESENTATION, type EditorialObjectState } from '@core/lib/admin/editorial-state';
import { chatWorkLabel } from '@core/lib/admin/work-summary';
import type { ObjectType } from '@core/schema/object-record-v1';

async function token(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

const FAMILIES: Array<{ id: string; label: string; types: ObjectType[] }> = [
  { id: 'foundation', label: 'Foundation', types: ['site', 'editorial_voice', 'theme', 'taxonomy', 'tracking_config'] },
  { id: 'structure', label: 'Structure', types: ['page', 'navigation', 'section'] },
  { id: 'templates', label: 'Templates', types: ['template', 'section_template'] },
  { id: 'content', label: 'Content', types: ['content_item', 'product'] },
];

export function buildObjectTree(
  rows: readonly LibraryRow[],
  states: Record<string, EditorialObjectState> = {},
  workByObject: Record<string, ChatSummaryView> = {}
): TreeNode[] {
  return FAMILIES.map((family) => {
    const familyRows = rows.filter((row) => family.types.includes(row.object_type));
    const typeNodes = family.types.reduce<TreeNode[]>((nodes, type) => {
      const typeRows = familyRows.filter((row) => row.object_type === type);
      if (!typeRows.length) return nodes;
      nodes.push({
        id: `type:${type}`,
        label: objectTypeLabel(type),
        badge: (
          <span className="text-[length:var(--adm-text-xs)] tabular-nums text-[var(--adm-text-muted)]">
            {typeRows.length}
          </span>
        ),
        children: typeRows.map((row) => {
          const state = states[row.object_id] ? EDITORIAL_STATE_PRESENTATION[states[row.object_id]] : rowStatus(row);
          const work = workByObject[row.object_id];
          return {
            id: row.object_id,
            label: row.display_name,
            href: `/admin/content/${encodeURIComponent(row.object_id)}?type=${row.object_type}`,
            badge: work ? (
              <span className="text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-info-text)]">
                {chatWorkLabel(work)}
              </span>
            ) : (
              <span
                title={state.label}
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${state.tone === 'success' ? 'bg-[var(--adm-success)]' : state.tone === 'warning' ? 'bg-[var(--adm-warning)]' : state.tone === 'info' ? 'bg-[var(--adm-info)]' : 'bg-[var(--adm-border-strong)]'}`}
              />
            ),
          } satisfies TreeNode;
        }),
      });
      return nodes;
    }, []);
    return {
      id: `family:${family.id}`,
      label: family.label,
      badge: <Badge tone="neutral">{familyRows.length}</Badge>,
      children: typeNodes,
    } satisfies TreeNode;
  }).filter((node) => node.children?.length);
}

export function expandedAncestorsForActiveId(nodes: readonly TreeNode[], activeId?: string): string[] | undefined {
  if (!activeId) return undefined;

  const visit = (candidates: readonly TreeNode[], ancestors: string[]): string[] | undefined => {
    for (const node of candidates) {
      if (node.id === activeId) return ancestors;
      if (node.children?.length) {
        const match = visit(node.children, [...ancestors, node.id]);
        if (match) return match;
      }
    }
    return undefined;
  };

  return visit(nodes, []);
}

export function ObjectBrowser({
  activeId,
  refreshSignal,
}: {
  activeId?: string;
  /**
   * Bump this (e.g. from a sibling ObjectWorkspace after publish/approve, or
   * on its chat write-stamp) to force a re-fetch — fixed defect: this tree
   * used to fetch once on mount and never again, so it could show a
   * contradictory state (stale pill, stale Publish/Approve affordance) right
   * next to a workspace that had just changed the same object.
   */
  refreshSignal?: number;
}) {
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [states, setStates] = useState<Record<string, EditorialObjectState>>({});
  const [workByObject, setWorkByObject] = useState<Record<string, ChatSummaryView>>({});

  useEffect(() => {
    let live = true;
    Promise.all([
      fetchInventoryRows(token),
      fetchReleaseOverview(token).catch(() => undefined),
      listChats(token).catch((): { chats: ChatSummaryView[] } => ({ chats: [] })),
    ])
      .then(([next, overview, chatResult]) => {
        if (!live) return;
        setRows(next);
        setStates(Object.fromEntries((overview?.objects ?? []).map((object) => [object.object_id, object.state])));
        setWorkByObject(
          Object.fromEntries(
            chatResult.chats
              .filter((chat) =>
                ['queued', 'running', 'awaiting_approval', 'awaiting_candidate', 'error'].includes(chat.status)
              )
              .filter((chat): chat is ChatSummaryView & { object_id: string } => Boolean(chat.object_id))
              .map((chat) => [chat.object_id, chat])
          )
        );
      })
      .catch(() => {})
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [refreshSignal]);

  const filtered = useMemo(() => filterRows(rows, { query }), [query, rows]);
  const treeNodes = useMemo(() => buildObjectTree(filtered, states, workByObject), [filtered, states, workByObject]);
  const defaultExpandedIds = useMemo(() => expandedAncestorsForActiveId(treeNodes, activeId), [activeId, treeNodes]);
  return (
    <aside
      className="flex min-h-0 flex-col border-r border-[var(--adm-border)] pr-3"
      aria-label="Editorial object browser"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[length:var(--adm-text-sm)] font-semibold text-[var(--adm-text-heading)]">Publication</h2>
        <span className="text-[length:var(--adm-text-xs)] tabular-nums text-[var(--adm-text-muted)]">
          {rows.length}
        </span>
      </div>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search publication…"
        aria-label="Search publication objects"
      />
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <Skeleton variant="rect" height={240} />
        ) : (
          <Tree
            nodes={treeNodes}
            activeId={activeId}
            defaultExpandedIds={defaultExpandedIds}
            ariaLabel="Publication objects"
            storageKey="object-browser-v2"
          />
        )}
      </div>
      <a
        href="/admin/objects"
        className="adm-focusable mt-3 rounded px-2 py-1 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-accent)] hover:underline"
      >
        Open full objects library
      </a>
    </aside>
  );
}
