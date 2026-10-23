/**
 * @novorb/mcp-core - Tool result limits
 *
 * `registerTools` enforces two caps on every tool result, by default:
 *
 * - items: a list-shaped result (`structuredContent` of the `PagedResult` shape `{ items, nextCursor?,
 *   total? }`) carries at most `maxItems` items (MCP_MAX_RESULT_ITEMS, default 100; a smaller `limit`
 *   argument wins). The rest is reached through an opaque `nextCursor`.
 * - bytes: the serialized result is at most `maxBytes` (MCP_MAX_RESULT_BYTES, default 256 KiB). A
 *   list-shaped result is first paged smaller; anything still too large becomes an actionable isError
 *   result (never a truncated, invalid or schema-breaking body).
 *
 * Cursors are stateless. mcp-core's cursor records the tool, a fingerprint of the other arguments, the
 * offset inside the handler's page, and the handler's own cursor for that page; on the next call the
 * handler is re-run with its own cursor (as `args.cursor` and `ctx.cursor`) and mcp-core serves the next
 * slice, or wraps the handler's own `nextCursor` once its page is exhausted. A cursor for another tool or
 * other arguments, or a malformed one, is refused (`Invalid cursor: ...`), so an edited cursor can only
 * ever address the caller's own result set. The handler must be a deterministic read for a given cursor
 * (list tools are).
 */

import { createHash } from 'node:crypto';
import type { AuthInfo, CallToolResult, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { decodeCursor, encodeCursor, InvalidCursorError, type JsonValue } from './pagination.js';
import { getLogger } from './utils/logger.js';

/** Per-tool overrides of the response caps. */
export interface ToolLimits {
  /** Max items in a list-shaped result. */
  maxItems?: number;
  /** Max serialized bytes of one result. */
  maxBytes?: number;
}

/** What `onOversize` receives when a result cannot be brought under the byte cap. */
export interface OversizeInfo {
  tool: string;
  bytes: number;
  maxBytes: number;
  result: CallToolResult;
  /** The caller, when the transport authenticated one (bind a spilled result to it). */
  authInfo?: AuthInfo;
}

/** The decoded mcp-core tool cursor. */
export interface ToolCursor {
  /** Offset inside the handler's page. */
  o: number;
  /** The handler's own cursor for that page (absent = its first page). */
  c?: string;
}

interface PagedShape {
  items: unknown[];
  nextCursor?: unknown;
  total?: unknown;
  [key: string]: unknown;
}

function isPagedShape(value: unknown): value is PagedShape {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && Array.isArray((value as PagedShape).items)
  );
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = stable((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** A short fingerprint of the arguments other than `cursor` / `limit` (binds a cursor to its query). */
export function argsFingerprint(args: unknown): string {
  const rest = typeof args === 'object' && args !== null ? { ...(args as Record<string, unknown>) } : {};
  delete rest.cursor;
  delete rest.limit;
  return createHash('sha256')
    .update(JSON.stringify(stable(rest)) ?? '')
    .digest('hex')
    .slice(0, 16);
}

function isToolCursorData(tool: string, fingerprint: string) {
  return (data: JsonValue): data is { t: string; h: string; o: number; c?: string } => {
    const r = typeof data === 'object' && data !== null && !Array.isArray(data) ? data : undefined;
    if (!r || typeof r.t !== 'string') return false;
    if (r.t !== tool) throw new InvalidCursorError('issued for another tool');
    if (r.h !== fingerprint) throw new InvalidCursorError('issued for other arguments');
    return (
      typeof r.o === 'number' && Number.isInteger(r.o) && r.o >= 0 && (r.c === undefined || typeof r.c === 'string')
    );
  };
}

/**
 * Decode `cursor` as an mcp-core tool cursor. Returns undefined when it is not one (a handler's own
 * cursor; only allowed when `strict` is false). Throws `InvalidCursorError` for a mismatch.
 */
export function decodeToolCursor(tool: string, args: unknown, cursor: string, strict: boolean): ToolCursor | undefined {
  try {
    const data = decodeCursor(cursor, { validate: isToolCursorData(tool, argsFingerprint(args)) });
    return data.c !== undefined ? { o: data.o, c: data.c } : { o: data.o };
  } catch (e) {
    if (e instanceof InvalidCursorError && /another tool|other arguments/.test(e.message)) throw e;
    if (strict) throw e instanceof InvalidCursorError ? e : new InvalidCursorError('unrecognised format');
    return undefined;
  }
}

function encodeToolCursor(tool: string, args: unknown, position: ToolCursor): string {
  const data: Record<string, JsonValue> = { t: tool, h: argsFingerprint(args), o: position.o };
  if (position.c !== undefined) data.c = position.c;
  return encodeCursor(data);
}

/** The arguments handed to the handler: `cursor` = its own cursor (or none), `limit` capped. */
export function handlerArgs(args: unknown, decoded: ToolCursor | undefined, maxItems: number): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (decoded) {
    if (decoded.c !== undefined) out.cursor = decoded.c;
    else delete out.cursor;
  }
  if (typeof out.limit === 'number') out.limit = Math.max(1, Math.min(Math.floor(out.limit), maxItems));
  return out;
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface EnforceContext {
  tool: string;
  /** The client's arguments (cursor and limit as sent). */
  args: unknown;
  decoded: ToolCursor | undefined;
  maxItems: number;
  maxBytes: number;
  onOversize?: (info: OversizeInfo) => CallToolResult | undefined;
  authInfo?: AuthInfo;
}

function oversizeError(tool: string, bytes: number, maxBytes: number, paged: boolean): CallToolResult {
  const hint = paged
    ? 'even one item is too large; request fewer fields or a narrower item'
    : 'narrow the request (filters, fewer fields, a smaller range) or use a paginated variant with cursor/limit';
  return {
    content: [
      {
        type: 'text',
        text: `${tool}: the result is ${bytes} bytes, over the ${maxBytes} byte limit per response; ${hint}`,
      },
    ],
    isError: true,
  };
}

function pageOf(ctx: EnforceContext, result: CallToolResult, sc: PagedShape, limit: number): CallToolResult {
  const offset = ctx.decoded?.o ?? 0;
  const end = offset + limit;
  const page: PagedShape = { ...sc, items: sc.items.slice(offset, end) };
  delete page.nextCursor;
  const inner = ctx.decoded?.c;
  let next: ToolCursor | undefined;
  if (end < sc.items.length) next = inner !== undefined ? { o: end, c: inner } : { o: end };
  else if (typeof sc.nextCursor === 'string' && sc.nextCursor !== '') next = { o: 0, c: sc.nextCursor };
  if (next) page.nextCursor = encodeToolCursor(ctx.tool, ctx.args, next);
  const first = result.content[0];
  const textWasDump = result.content.length === 1 && first?.type === 'text' && first.text === pretty(sc);
  const cut = page.items.length < sc.items.length;
  const content: CallToolResult['content'] =
    cut || textWasDump ? [{ type: 'text', text: pretty(page) }] : result.content;
  return { ...result, content, structuredContent: page };
}

/** Apply the item and byte caps to one handler result. */
export function enforceResultLimits(ctx: EnforceContext, result: CallToolResult): CallToolResult {
  const log = getLogger();
  const sc = result.isError === true ? undefined : result.structuredContent;
  let out = result;
  if (isPagedShape(sc)) {
    const requested = typeof (ctx.args as { limit?: unknown } | undefined)?.limit === 'number';
    const limit = Math.max(
      1,
      Math.min(requested ? Number((ctx.args as { limit: number }).limit) : ctx.maxItems, ctx.maxItems),
    );
    const needsPaging = (ctx.decoded?.o ?? 0) > 0 || sc.items.length > limit || typeof sc.nextCursor === 'string';
    if (needsPaging) {
      out = pageOf(ctx, result, sc, limit);
      const served = (out.structuredContent as PagedShape).items.length;
      if (served < sc.items.length) {
        log.info(`Tool result paged: ${ctx.tool}`, 'Tools', { tool: ctx.tool, items: sc.items.length, served, limit });
      }
    }
    let bytes = byteSize(out);
    let size = (out.structuredContent as PagedShape).items.length;
    while (bytes > ctx.maxBytes && size > 1) {
      size = Math.max(1, Math.floor(size / 2));
      out = pageOf(ctx, result, sc, size);
      bytes = byteSize(out);
    }
    if (size < limit && bytes <= ctx.maxBytes) {
      log.warn(`Tool result paged to fit the byte limit: ${ctx.tool}`, 'Tools', {
        tool: ctx.tool,
        items: sc.items.length,
        served: size,
        bytes,
        maxBytes: ctx.maxBytes,
      });
    }
  }
  const bytes = byteSize(out);
  if (bytes <= ctx.maxBytes) return out;
  log.warn(`Tool result over the byte limit: ${ctx.tool}`, 'Tools', {
    tool: ctx.tool,
    bytes,
    maxBytes: ctx.maxBytes,
    isError: out.isError === true,
  });
  const replacement = ctx.onOversize?.({
    tool: ctx.tool,
    bytes,
    maxBytes: ctx.maxBytes,
    result: out,
    ...(ctx.authInfo ? { authInfo: ctx.authInfo } : {}),
  });
  if (replacement && byteSize(replacement) <= ctx.maxBytes) return replacement;
  return oversizeError(ctx.tool, bytes, ctx.maxBytes, isPagedShape(sc));
}

/** Whether an input schema declares `cursor` and `limit` properties (required for `paginated` tools). */
export function declaresPageArgs(schema: StandardSchemaWithJSON): boolean {
  try {
    const json = schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as {
      properties?: Record<string, unknown>;
    };
    return json.properties?.cursor !== undefined && json.properties?.limit !== undefined;
  } catch {
    return true;
  }
}
