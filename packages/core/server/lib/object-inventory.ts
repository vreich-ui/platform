/**
 * Object inventory (Part 2 of the agent-editability push) — the read-only
 * "what exists and what state is it in" view over the object store, for
 * agents deciding what to edit next and for humans auditing pending work.
 *
 * Pure derivation over ObjectRecord envelopes: no writes, no new stored
 * state. Every field is computed from what the T0.5/T1.3 verbs already
 * persist — in particular `unpublished_changes` works because the publish
 * receipt (T1.3) stamps the `content_revision` it materialized, so a record
 * whose current revision is ahead of its receipt has changes the live site
 * has not seen.
 *
 * M3.3 moved the ROW — the types, the body summaries and
 * `inventoryRowFromRecord` — into the leaf `object-inventory-row.ts`, and
 * re-exports it here so every existing import of this file is unchanged. What
 * stays is what a caller does with rows once it has them. See that file for
 * which cold start the split is for.
 */
import type { ApprovalPolicy } from '../../lib/approval-policy.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';
import {
  inventoryRowFromRecord,
  type InventoryReviewState,
  type InventoryRow,
} from './object-inventory-row.js';

export * from './object-inventory-row.js';

export type InventoryDetail = InventoryRow & {
  schema_version: string;
  site: string;
  created_at: string;
  updated_at: string;
  review: ObjectRecord['review'] | null;
  publish_receipt: Record<string, unknown> | null;
  history_length: number;
};

export type InventoryFilters = {
  requires_approval?: boolean;
  review_state?: InventoryReviewState;
  pending_changes?: boolean;
  status?: 'active' | 'archived';
};

export const inventoryDetailFromRecord = (
  record: ObjectRecord,
  atMs: number,
  policy?: ApprovalPolicy
): InventoryDetail => ({
  ...inventoryRowFromRecord(record, atMs, policy),
  schema_version: record.schema_version,
  site: record.site,
  created_at: record.created_at,
  updated_at: record.updated_at,
  review: record.review ?? null,
  publish_receipt: record.publication.publish_receipt ?? null,
  history_length: record.history.length,
});

export const matchesInventoryFilters = (row: InventoryRow, filters: InventoryFilters): boolean => {
  if (filters.status !== undefined && row.status !== filters.status) return false;
  if (filters.requires_approval !== undefined && row.requires_approval !== filters.requires_approval) return false;
  if (filters.review_state !== undefined && row.review_state !== filters.review_state) return false;
  if (filters.pending_changes !== undefined && row.unpublished_changes !== filters.pending_changes) return false;
  return true;
};

/** Stable output order: object_type in canonical enum order, then object_id. */
export const compareInventoryRows =
  (typeOrder: readonly string[]) =>
  (a: InventoryRow, b: InventoryRow): number => {
    const typeDelta = typeOrder.indexOf(a.object_type) - typeOrder.indexOf(b.object_type);
    if (typeDelta !== 0) return typeDelta;
    return a.object_id < b.object_id ? -1 : a.object_id > b.object_id ? 1 : 0;
  };
