/**
 * Deterministic pagination for the owner-only maintenance blob browser.
 *
 * The blob list endpoint is deliberately capped, but a large (yet valid)
 * response should still never create thousands of table rows or metadata
 * requests in the browser at once.
 */
export const MAINTENANCE_PAGE_SIZES = [25, 50, 100] as const;

export interface PaginationWindow<T> {
  page: number;
  pageCount: number;
  startIndex: number;
  endIndex: number;
  rows: readonly T[];
}

export function paginateMaintenanceRows<T>(
  rows: readonly T[],
  requestedPage: number,
  pageSize: number
): PaginationWindow<T> {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = rows.length === 0 ? 0 : Math.ceil(rows.length / safePageSize);
  const page = pageCount === 0 ? 1 : Math.min(Math.max(1, Math.floor(requestedPage)), pageCount);
  const startIndex = pageCount === 0 ? 0 : (page - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, rows.length);

  return {
    page,
    pageCount,
    startIndex,
    endIndex,
    rows: rows.slice(startIndex, endIndex),
  };
}
