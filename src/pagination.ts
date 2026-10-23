/**
 * @novorb/mcp-core - Pagination utilities
 *
 * Three groups:
 * - page-number helpers for list tools (`normalizePagination`, `createPaginationMetadata`,
 *   `pageToOffset`, `paginateArray`);
 * - HTTP-side strategies that walk an upstream API's pages (`pagePerPage`, `nextPageHeader`,
 *   `offsetLimit`, `linkHeader`, `nextLinkField`, `continuationToken`), run by `paginateRequests`
 *   (and `McpHttpClient.paginate`) with a stop condition per strategy and a hard page cap;
 * - MCP-side opaque cursors and one paged result contract for list tools (`encodeCursor`,
 *   `decodeCursor`, `invalidCursorResult`, `paginateArrayByCursor`, `PagedResult`,
 *   `pagedResultSchema`).
 */

import type * as zt from 'zod';
import type { HttpResponse, QueryParams, RequestOptions } from './http-client.js';
import { HARD_MAX_COLLECT_ITEMS, resolveLimits } from './limits.js';

// ---------------------------------------------------------------------------------------------------
// Page-number helpers
// ---------------------------------------------------------------------------------------------------

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

export interface NormalizePaginationOptions {
  /** Maximum allowed per_page (default: 100). */
  maxPerPage?: number;
  /** Default per_page (default: 20). */
  defaultPerPage?: number;
  /** `clamp` (default) bounds out-of-range values; `throw` rejects them with a RangeError. */
  onInvalid?: 'clamp' | 'throw';
}

/**
 * Normalize pagination parameters with sensible bounds.
 *
 * @param params - Raw pagination params
 * @param maxPerPageOrOptions - Maximum per_page (default: 100), or an options object
 * @param defaultPerPage - Default per_page (default: 20; ignored when an options object is passed)
 */
export function normalizePagination(
  params?: PaginationParams,
  maxPerPageOrOptions: number | NormalizePaginationOptions = 100,
  defaultPerPage = 20,
): NormalizedPagination {
  const opts: NormalizePaginationOptions =
    typeof maxPerPageOrOptions === 'number' ? { maxPerPage: maxPerPageOrOptions, defaultPerPage } : maxPerPageOrOptions;
  const maxPerPage = opts.maxPerPage ?? 100;
  const fallbackPerPage = opts.defaultPerPage ?? 20;
  if (opts.onInvalid === 'throw') {
    const page = params?.page ?? 1;
    const perPage = params?.per_page ?? fallbackPerPage;
    if (!Number.isInteger(page) || page < 1) {
      throw new RangeError(`page must be an integer >= 1 (got ${page})`);
    }
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > maxPerPage) {
      throw new RangeError(`per_page must be an integer between 1 and ${maxPerPage} (got ${perPage})`);
    }
    return { page, per_page: perPage };
  }
  const page = Math.max(1, params?.page ?? 1);
  const per_page = Math.min(maxPerPage, Math.max(1, params?.per_page ?? fallbackPerPage));
  return { page, per_page };
}

/**
 * Create pagination metadata from total count and normalized params.
 */
export function createPaginationMetadata(totalCount: number, params: NormalizedPagination): PaginationMetadata {
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
  params: NormalizedPagination,
): { data: T[]; metadata: PaginationMetadata } {
  const offset = pageToOffset(params.page, params.per_page);
  const data = items.slice(offset, offset + params.per_page);
  return {
    data,
    metadata: createPaginationMetadata(items.length, params),
  };
}

// ---------------------------------------------------------------------------------------------------
// HTTP-side strategies
// ---------------------------------------------------------------------------------------------------

/** One fetched page. */
export interface Page<T> {
  items: T[];
  /** 0-based index of the page in this walk. */
  pageIndex: number;
  /** Total item count when the API reports one. */
  total?: number;
}

/** What a strategy extracts from one response. `next` absent = the last page. */
export interface PageParseResult<T> {
  items: T[];
  total?: number;
  next?: RequestOptions;
}

/** How to walk one API's pages. */
export interface PaginationStrategy<T> {
  readonly name: string;
  /** Decorates the caller's first request (page size, start page). */
  first(request: RequestOptions): RequestOptions;
  /** Extracts the page's items, the total, and the next request (absent = stop). */
  parse(response: HttpResponse<unknown>, request: RequestOptions): PageParseResult<T>;
}

export interface PaginateOptions {
  /** Stop after this many pages (default 100, never above HARD_MAX_PAGES). */
  maxPages?: number;
  /**
   * Stop once this many items are collected (the last page is trimmed). Default MCP_MAX_RESULT_ITEMS
   * (100); never above HARD_MAX_COLLECT_ITEMS (100000). `collect()` reports `truncated` when it stopped.
   */
  maxItems?: number;
}

export type PaginationStopReason = 'end' | 'maxPages' | 'maxItems' | 'repeated';

export interface CollectResult<T> {
  items: T[];
  total?: number;
  pages: number;
  /** Why the walk stopped. `repeated` = the API sent the same next request twice. */
  stopReason: PaginationStopReason;
  /** True when the walk stopped before the API's last page. */
  truncated: boolean;
}

export interface PageIterator<T> extends AsyncIterable<Page<T>> {
  /** Iterate items across pages. */
  items(): AsyncIterable<T>;
  /** Walk every page (within the caps) and gather the items. */
  collect(): Promise<CollectResult<T>>;
}

export const DEFAULT_MAX_PAGES = 100;
/** Absolute ceiling on any walk, whatever the caller asks for. */
export const HARD_MAX_PAGES = 10000;

/** Extracts the items of a response body. */
export type ItemsExtractor<T> = (body: unknown) => T[];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Default items extractor: an array body, else the first array under value/items/data/results. */
export function defaultItems<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const record = asRecord(body);
  if (record) {
    for (const key of ['value', 'items', 'data', 'results']) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

function itemsFrom<T>(items: string | ItemsExtractor<T> | undefined): ItemsExtractor<T> {
  if (typeof items === 'function') return items;
  if (typeof items === 'string') {
    return (body: unknown): T[] => {
      const candidate = asRecord(body)?.[items];
      return Array.isArray(candidate) ? (candidate as T[]) : [];
    };
  }
  return defaultItems;
}

/** Reads a non-negative integer header (e.g. `X-Total`, `X-Total-Count`); undefined when absent. */
export function readHeaderTotal(headers: Record<string, string>, name: string): number | undefined {
  const raw = headers[name.toLowerCase()];
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return undefined;
  return Number(raw.trim());
}

function readBodyNumber(body: unknown, field: string): number | undefined {
  const value = asRecord(body)?.[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readBodyString(body: unknown, field: string): string | undefined {
  const value = asRecord(body)?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface TotalSource {
  /** Response header carrying the total (e.g. `x-total`, `x-total-count`). */
  totalHeader?: string;
  /** Body field carrying the total (e.g. `@odata.count`, `total`). */
  totalField?: string;
}

function totalOf(response: HttpResponse<unknown>, source: TotalSource): number | undefined {
  if (source.totalHeader) {
    const total = readHeaderTotal(response.headers, source.totalHeader);
    if (total !== undefined) return total;
  }
  return source.totalField ? readBodyNumber(response.data, source.totalField) : undefined;
}

function withQuery(request: RequestOptions, patch: QueryParams): RequestOptions {
  return { ...request, query: { ...request.query, ...patch } };
}

function numericQuery(request: RequestOptions, name: string, fallback: number): number {
  const value = request.query?.[name];
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(num) ? num : fallback;
}

export interface PagePerPageOptions<T> extends TotalSource {
  /** Page query parameter (default `page`). */
  pageParam?: string;
  /** Page size query parameter (default `per_page`). */
  sizeParam?: string;
  /** Page size (default 100). */
  pageSize?: number;
  /** First page number (default 1). */
  startPage?: number;
  /** Items field name or extractor (default `defaultItems`). */
  items?: string | ItemsExtractor<T>;
}

/**
 * Page-number pagination (`page` + `per_page`). Stops on an empty or short page, or once
 * page * size reaches the total (from `totalHeader` / `totalField`).
 */
export function pagePerPage<T>(options: PagePerPageOptions<T> = {}): PaginationStrategy<T> {
  const pageParam = options.pageParam ?? 'page';
  const sizeParam = options.sizeParam ?? 'per_page';
  const pageSize = options.pageSize ?? 100;
  const startPage = options.startPage ?? 1;
  const extract = itemsFrom(options.items);
  return {
    name: 'pagePerPage',
    first: (request) => withQuery(request, { [pageParam]: startPage, [sizeParam]: pageSize }),
    parse: (response, request) => {
      const items = extract(response.data);
      const total = totalOf(response, options);
      const page = numericQuery(request, pageParam, startPage);
      const seen = (page - startPage + 1) * pageSize;
      const done = items.length === 0 || items.length < pageSize || (total !== undefined && seen >= total);
      return { items, total, next: done ? undefined : withQuery(request, { [pageParam]: page + 1 }) };
    },
  };
}

export interface NextPageHeaderOptions<T> extends TotalSource {
  /** Header naming the next page number (default `x-next-page`); empty or absent = last page. */
  header?: string;
  pageParam?: string;
  sizeParam?: string;
  pageSize?: number;
  items?: string | ItemsExtractor<T>;
}

/**
 * Next-page header pagination (GitLab: `X-Next-Page`, empty on the last page; total from `X-Total`,
 * which gitlab.com omits above 10k rows, so the header and not the total drives the walk).
 */
export function nextPageHeader<T>(options: NextPageHeaderOptions<T> = {}): PaginationStrategy<T> {
  const header = (options.header ?? 'x-next-page').toLowerCase();
  const pageParam = options.pageParam ?? 'page';
  const sizeParam = options.sizeParam ?? 'per_page';
  const pageSize = options.pageSize ?? 100;
  const source: TotalSource = { totalHeader: options.totalHeader ?? 'x-total', totalField: options.totalField };
  const extract = itemsFrom(options.items);
  return {
    name: 'nextPageHeader',
    first: (request) => withQuery(request, { [pageParam]: 1, [sizeParam]: pageSize }),
    parse: (response, request) => {
      const items = extract(response.data);
      const raw = (response.headers[header] ?? '').trim();
      const nextPage = /^\d+$/.test(raw) ? Number(raw) : undefined;
      const next =
        nextPage !== undefined && items.length > 0 ? withQuery(request, { [pageParam]: nextPage }) : undefined;
      return { items, total: totalOf(response, source), next };
    },
  };
}

export interface OffsetLimitOptions<T> extends TotalSource {
  offsetParam?: string;
  limitParam?: string;
  /** Page size (default 100). */
  limit?: number;
  /** First offset (default 0). */
  startOffset?: number;
  items?: string | ItemsExtractor<T>;
}

/** Offset/limit pagination. Stops on an empty or short page, or once offset + items reaches the total. */
export function offsetLimit<T>(options: OffsetLimitOptions<T> = {}): PaginationStrategy<T> {
  const offsetParam = options.offsetParam ?? 'offset';
  const limitParam = options.limitParam ?? 'limit';
  const limit = options.limit ?? 100;
  const startOffset = options.startOffset ?? 0;
  const extract = itemsFrom(options.items);
  return {
    name: 'offsetLimit',
    first: (request) => withQuery(request, { [offsetParam]: startOffset, [limitParam]: limit }),
    parse: (response, request) => {
      const items = extract(response.data);
      const total = totalOf(response, options);
      const offset = numericQuery(request, offsetParam, startOffset);
      const reached = offset + items.length;
      const done = items.length === 0 || items.length < limit || (total !== undefined && reached >= total);
      return { items, total, next: done ? undefined : withQuery(request, { [offsetParam]: reached }) };
    },
  };
}

/** Parses an RFC 8288 (RFC 5988) `Link` header into rel -> URL. Space-separated rels map each. */
export function parseLinkHeader(value: string | undefined): Record<string, string> {
  const links: Record<string, string> = {};
  if (!value) return links;
  const pattern = /<([^>]*)>((?:\s*;\s*[^;,]+)*)/g;
  for (const match of value.matchAll(pattern)) {
    const url = match[1];
    const relMatch = /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(match[2]);
    if (!relMatch) continue;
    for (const rel of relMatch[1].trim().split(/\s+/)) {
      if (!(rel in links)) links[rel] = url;
    }
  }
  return links;
}

export interface LinkHeaderOptions<T> extends TotalSource {
  /** Link relation to follow (default `next`). */
  rel?: string;
  items?: string | ItemsExtractor<T>;
}

/**
 * RFC 5988 `Link: <url>; rel="next"` pagination (GitLab keyset, GitHub). The next URL is used as-is
 * (it carries its own query), so the caller's query is dropped on follow-up requests.
 */
export function linkHeader<T>(options: LinkHeaderOptions<T> = {}): PaginationStrategy<T> {
  const rel = options.rel ?? 'next';
  const extract = itemsFrom(options.items);
  return {
    name: 'linkHeader',
    first: (request) => request,
    parse: (response, request) => {
      const nextUrl = parseLinkHeader(response.headers.link)[rel];
      return {
        items: extract(response.data),
        total: totalOf(response, options),
        next: nextUrl ? { ...request, path: nextUrl, query: undefined } : undefined,
      };
    },
  };
}

export interface NextLinkFieldOptions<T> extends TotalSource {
  /** Body field holding the absolute next URL (default `@odata.nextLink`). */
  field?: string;
  /** Items field (default `value`). */
  items?: string | ItemsExtractor<T>;
}

/**
 * Body next-link pagination (Microsoft Graph `@odata.nextLink`, total `@odata.count`). The next link
 * is absolute and already contains the API version segment, so it is requested as-is.
 */
export function nextLinkField<T>(options: NextLinkFieldOptions<T> = {}): PaginationStrategy<T> {
  const field = options.field ?? '@odata.nextLink';
  const source: TotalSource = { totalHeader: options.totalHeader, totalField: options.totalField ?? '@odata.count' };
  const extract = itemsFrom(options.items ?? 'value');
  return {
    name: 'nextLinkField',
    first: (request) => request,
    parse: (response, request) => {
      const nextUrl = readBodyString(response.data, field);
      return {
        items: extract(response.data),
        total: totalOf(response, source),
        next: nextUrl ? { ...request, path: nextUrl, query: undefined } : undefined,
      };
    },
  };
}

export interface ContinuationTokenOptions<T> extends TotalSource {
  /** Query parameter that carries the token on the next request (default `continuationToken`). */
  requestParam?: string;
  /** Body field holding the token, or a function of (body, items) (default `continuationToken`). */
  token?: string | ((body: unknown, items: T[]) => string | undefined);
  /** Items field (default `items`). */
  items?: string | ItemsExtractor<T>;
}

/**
 * Continuation-token pagination (Nexus `continuationToken`; Trello `before=<last id>` via a token
 * function). Stops when the token is absent or empty, or the page is empty.
 */
export function continuationToken<T>(options: ContinuationTokenOptions<T> = {}): PaginationStrategy<T> {
  const requestParam = options.requestParam ?? 'continuationToken';
  const tokenSource = options.token ?? 'continuationToken';
  const extract = itemsFrom(options.items ?? 'items');
  return {
    name: 'continuationToken',
    first: (request) => request,
    parse: (response, request) => {
      const items = extract(response.data);
      const token =
        typeof tokenSource === 'function'
          ? tokenSource(response.data, items)
          : readBodyString(response.data, tokenSource);
      const next = token && items.length > 0 ? withQuery(request, { [requestParam]: token }) : undefined;
      return { items, total: totalOf(response, options), next };
    },
  };
}

function requestKey(request: RequestOptions): string {
  const query = request.query ?? {};
  const sorted = Object.keys(query)
    .sort()
    .map((key) => [key, query[key]]);
  return `${request.path}?${JSON.stringify(sorted)}`;
}

/**
 * Walks pages with a strategy. Each iteration of the returned iterator restarts the walk. Stops at the
 * strategy's last page, `maxPages` (default 100, capped at HARD_MAX_PAGES), `maxItems`, or when the API
 * repeats a next request (a loop).
 */
export function paginateRequests<T>(
  fetchPage: (request: RequestOptions) => Promise<HttpResponse<unknown>>,
  request: RequestOptions,
  strategy: PaginationStrategy<T>,
  options: PaginateOptions = {},
): PageIterator<T> {
  const maxPages = Math.min(HARD_MAX_PAGES, Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES));
  // Bounded by default: the same per-response item cap the tools enforce (MCP_MAX_RESULT_ITEMS), and an
  // explicit maxItems is still capped, so no walk pulls an unbounded upstream list into memory.
  const maxItems = Math.min(
    HARD_MAX_COLLECT_ITEMS,
    Math.max(1, Math.floor(options.maxItems ?? resolveLimits().maxResultItems)),
  );

  async function* walk(onStop: (reason: PaginationStopReason) => void): AsyncGenerator<Page<T>> {
    let current: RequestOptions | undefined = strategy.first(request);
    const seen = new Set<string>();
    let collected = 0;
    for (let pageIndex = 0; current; pageIndex++) {
      if (pageIndex >= maxPages) {
        onStop('maxPages');
        return;
      }
      const key = requestKey(current);
      if (seen.has(key)) {
        onStop('repeated');
        return;
      }
      seen.add(key);
      const response = await fetchPage(current);
      const parsed = strategy.parse(response, current);
      let items = parsed.items;
      if (collected + items.length >= maxItems) {
        items = items.slice(0, Math.max(0, maxItems - collected));
        const more = parsed.next !== undefined || items.length < parsed.items.length;
        yield { items, pageIndex, total: parsed.total };
        onStop(more ? 'maxItems' : 'end');
        return;
      }
      collected += items.length;
      yield { items, pageIndex, total: parsed.total };
      current = parsed.next;
    }
    onStop('end');
  }

  return {
    [Symbol.asyncIterator]: () => walk(() => undefined),
    items: () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<T> {
        for await (const page of walk(() => undefined)) yield* page.items;
      },
    }),
    collect: async (): Promise<CollectResult<T>> => {
      let stopReason: PaginationStopReason = 'end';
      const items: T[] = [];
      let total: number | undefined;
      let pages = 0;
      for await (const page of walk((reason) => {
        stopReason = reason;
      })) {
        items.push(...page.items);
        total = page.total ?? total;
        pages++;
      }
      return { items, total, pages, stopReason, truncated: stopReason !== 'end' };
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// MCP-side cursors and the paged result contract
// ---------------------------------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const CURSOR_VERSION = 1;
/** Longest cursor `decodeCursor` accepts (bounded input). */
export const MAX_CURSOR_LENGTH = 2048;

/** Thrown by `decodeCursor` for a malformed, foreign, or stale cursor. */
export class InvalidCursorError extends Error {
  constructor(reason: string) {
    super(`Invalid cursor: ${reason}`);
    this.name = 'InvalidCursorError';
  }
}

/** Encodes cursor state as an opaque, versioned base64url JSON string. */
export function encodeCursor(data: JsonValue, version: number = CURSOR_VERSION): string {
  return Buffer.from(JSON.stringify({ v: version, d: data }), 'utf8').toString('base64url');
}

export interface DecodeCursorOptions<T extends JsonValue> {
  /** Expected version (default CURSOR_VERSION); another version is rejected as stale. */
  version?: number;
  /** Type guard for the payload; a false result is rejected. */
  validate?: (data: JsonValue) => data is T;
}

/**
 * Decodes a cursor made by `encodeCursor`. Throws `InvalidCursorError` (message starts with
 * `Invalid cursor:`) for anything else.
 */
export function decodeCursor<T extends JsonValue = JsonValue>(cursor: string, options: DecodeCursorOptions<T> = {}): T {
  if (typeof cursor !== 'string' || cursor.length === 0) throw new InvalidCursorError('empty');
  if (cursor.length > MAX_CURSOR_LENGTH) throw new InvalidCursorError('too long');
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError('not base64url');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('not decodable');
  }
  const envelope = asRecord(parsed);
  if (!envelope || typeof envelope.v !== 'number' || !('d' in envelope)) {
    throw new InvalidCursorError('unrecognised format');
  }
  const expected = options.version ?? CURSOR_VERSION;
  if (envelope.v !== expected) throw new InvalidCursorError(`version ${envelope.v} is not ${expected}`);
  const data = envelope.d as JsonValue;
  if (options.validate && !options.validate(data)) throw new InvalidCursorError('unexpected content');
  return data as T;
}

/** Tool result for a bad cursor: `isError` with the error's message (a generic one otherwise). */
export function invalidCursorResult(error: unknown): {
  isError: true;
  content: [{ type: 'text'; text: string }];
} {
  const text = error instanceof InvalidCursorError ? error.message : 'Invalid cursor';
  return { isError: true, content: [{ type: 'text', text }] };
}

/** The one paged result shape list tools return. */
export interface PagedResult<T> {
  items: T[];
  /** Opaque cursor for the next page; absent on the last page. */
  nextCursor?: string;
  /** Total item count when known. */
  total?: number;
}

/** The zod members `pagedResultSchema` uses; pass the consumer's own `z`. */
export type PagedResultZod = Pick<typeof zt, 'object' | 'array' | 'string' | 'number'>;

/**
 * The zod output schema of `PagedResult<item>`. Takes the consumer's `z` so mcp-core never loads zod
 * at runtime: `outputSchema: pagedResultSchema(z, Project)`.
 */
export function pagedResultSchema<I extends zt.ZodType>(z: PagedResultZod, item: I) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
    total: z.number().int().nonnegative().optional(),
  });
}

export interface CursorPageOptions {
  /** Cursor from the previous page (absent = first page). */
  cursor?: string;
  /** Requested page size (default `defaultLimit`, clamped to 1..maxLimit). */
  limit?: number;
  defaultLimit?: number;
  maxLimit?: number;
}

function isOffsetCursor(data: JsonValue): data is { o: number } {
  const record = asRecord(data);
  return record !== undefined && typeof record.o === 'number' && Number.isInteger(record.o) && record.o >= 0;
}

/**
 * Cursor pagination over an in-memory array: returns a `PagedResult` whose `nextCursor` encodes the
 * next offset. Throws `InvalidCursorError` for a bad or out-of-range cursor.
 */
export function paginateArrayByCursor<T>(items: T[], options: CursorPageOptions = {}): PagedResult<T> {
  const maxLimit = options.maxLimit ?? 100;
  const limit = Math.min(maxLimit, Math.max(1, Math.floor(options.limit ?? options.defaultLimit ?? 20)));
  const offset = options.cursor ? decodeCursor(options.cursor, { validate: isOffsetCursor }).o : 0;
  if (offset > items.length) throw new InvalidCursorError('out of range');
  const end = offset + limit;
  const result: PagedResult<T> = { items: items.slice(offset, end), total: items.length };
  if (end < items.length) result.nextCursor = encodeCursor({ o: end });
  return result;
}
