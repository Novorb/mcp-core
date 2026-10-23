/**
 * @novorb/mcp-core - List pagination (`tools/list`, `prompts/list`, `resources/list`,
 * `resources/templates/list`)
 *
 * SDK v2's `McpServer` answers every list in ONE result with no cursor (its list handlers are installed
 * by private methods, with no paging option and no extension point). mcp-core pages them on the
 * documented low-level hook instead of forking McpServer: it decorates the public
 * `Server.setRequestHandler` of the instance so that whatever list handler is installed (the SDK's own,
 * lazily on the first `registerTool`, or a low-level consumer's) is wrapped. The wrapper calls that
 * handler unchanged and returns one page of its result plus an opaque `nextCursor`, so the list content
 * (schemas, enabled filter, `_meta`, era projection) stays 100% the SDK's.
 *
 * - On by default with `MCP_LIST_PAGE_SIZE` (default 100, so today's largest server fits one page);
 *   0 disables it.
 * - Cursors are brief-B cursors (`encodeCursor`) bound to the list method; a malformed, foreign or
 *   out-of-range cursor answers JSON-RPC `-32602`.
 * - A result that already carries `nextCursor` is left alone, but every cursor a client sends is
 *   decoded as an mcp-core list cursor; a low-level handler that pages a list itself must therefore not
 *   be combined with this (set `listPageSize: 0` for that server).
 * - SDK v2 clients follow `nextCursor` automatically (`listTools()` with no cursor walks up to
 *   `listMaxPages`, default 64); 2025-era clients are expected to by the spec (`cursor` / `nextCursor`
 *   on every list method since 2024-11-05).
 */

import { ProtocolError, ProtocolErrorCode, type Server } from '@modelcontextprotocol/server';
import { decodeCursor, encodeCursor, InvalidCursorError, type JsonValue } from './pagination.js';

/** The list methods and the result key each one carries. */
export const LIST_RESULT_KEYS = {
  'tools/list': 'tools',
  'prompts/list': 'prompts',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
} as const;

export type ListMethod = keyof typeof LIST_RESULT_KEYS;

type ListRequest = { params?: { cursor?: unknown } };
type AnyHandler = (request: ListRequest, ctx: unknown) => unknown;

function isListMethod(method: string): method is ListMethod {
  return Object.hasOwn(LIST_RESULT_KEYS, method);
}

function isListCursor(method: ListMethod) {
  return (data: JsonValue): data is { l: string; o: number } => {
    const r = typeof data === 'object' && data !== null && !Array.isArray(data) ? data : undefined;
    return r !== undefined && r.l === method && typeof r.o === 'number' && Number.isInteger(r.o) && r.o > 0;
  };
}

function invalid(error: unknown): ProtocolError {
  const message = error instanceof InvalidCursorError ? error.message : 'Invalid cursor';
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

/** One page of a full list result. Exported for tests and for hosts that page their own lists. */
export function pageListResult(
  method: ListMethod,
  result: Record<string, unknown>,
  cursor: unknown,
  pageSize: number,
): Record<string, unknown> {
  const key = LIST_RESULT_KEYS[method];
  const items = result[key];
  if (!Array.isArray(items) || result.nextCursor !== undefined) return result;
  let offset = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string') throw invalid(new InvalidCursorError('not a string'));
    try {
      offset = decodeCursor(cursor, { validate: isListCursor(method) }).o;
    } catch (e) {
      throw invalid(e);
    }
    if (offset >= items.length) throw invalid(new InvalidCursorError('out of range'));
  }
  if (offset === 0 && items.length <= pageSize) return result;
  const end = offset + pageSize;
  const page: Record<string, unknown> = { ...result, [key]: items.slice(offset, end) };
  if (end < items.length) page.nextCursor = encodeCursor({ l: method, o: end });
  return page;
}

function wrap(method: ListMethod, handler: AnyHandler, pageSize: number): AnyHandler {
  return async (request, ctx) => {
    const result = await handler(request, ctx);
    if (typeof result !== 'object' || result === null) return result;
    return pageListResult(method, result as Record<string, unknown>, request.params?.cursor, pageSize);
  };
}

const PAGINATED = Symbol.for('@novorb/mcp-core/listPagination');

/**
 * Page every list handler installed on `server` from now on (call before registering anything: the
 * SDK installs its list handlers lazily on the first registration). `pageSize <= 0` does nothing.
 * Idempotent per instance.
 */
export function paginateLists(server: Server, pageSize: number): void {
  if (pageSize <= 0) return;
  const target = server as unknown as Record<PropertyKey, unknown> & {
    setRequestHandler: (method: string, ...rest: unknown[]) => void;
  };
  if (target[PAGINATED]) return;
  target[PAGINATED] = true;
  const original = target.setRequestHandler.bind(server) as (method: string, ...rest: unknown[]) => void;
  target.setRequestHandler = (method: string, ...rest: unknown[]): void => {
    const handler = rest[0];
    if (isListMethod(method) && rest.length === 1 && typeof handler === 'function') {
      original(method, wrap(method, handler as AnyHandler, pageSize));
      return;
    }
    original(method, ...rest);
  };
}
