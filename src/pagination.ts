/**
 * @novorb/mcp-core — Pagination utilities
 *
 * Normalize and compute pagination metadata across MCP servers.
 */

export interface PaginationParams {
  /** Page number (1-based, default: 1) */
  page?: number;
  /** Items per page (default: 20, max: 100) */
  per_page?: number;
}

export interface NormalizedPagination {
  page: number;
  per_page: number;
}

export interface PaginationMetadata {
  totalCount: number;
  page: number;
  perPage: number;
  totalPages: number;
}

/**
 * Normalize pagination parameters with sensible bounds.
 *
 * @param params - Raw pagination params
 * @param maxPerPage - Maximum allowed per_page (default: 100)
 * @param defaultPerPage - Default per_page (default: 20)
 */
export function normalizePagination(
  params?: PaginationParams,
  maxPerPage = 100,
  defaultPerPage = 20
): NormalizedPagination {
  const page = Math.max(1, params?.page ?? 1);
  const per_page = Math.min(maxPerPage, Math.max(1, params?.per_page ?? defaultPerPage));
  return { page, per_page };
}

/**
 * Create pagination metadata from total count and normalized params.
 */
export function createPaginationMetadata(
  totalCount: number,
  params: NormalizedPagination
): PaginationMetadata {
  return {
    totalCount,
    page: params.page,
    perPage: params.per_page,
    totalPages: Math.ceil(totalCount / params.per_page),
  };
}

/**
 * Calculate offset for SQL/API pagination from 1-based page number.
 */
export function pageToOffset(page: number, perPage: number): number {
  return (Math.max(1, page) - 1) * perPage;
}

/**
 * Apply in-memory pagination to an array.
 */
export function paginateArray<T>(
  items: T[],
  params: NormalizedPagination
): { data: T[]; metadata: PaginationMetadata } {
  const offset = pageToOffset(params.page, params.per_page);
  const data = items.slice(offset, offset + params.per_page);
  return {
    data,
    metadata: createPaginationMetadata(items.length, params),
  };
}
