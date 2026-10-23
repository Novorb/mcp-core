/**
 * @novorb/mcp-core - Server
 *
 * Re-exports and base patterns for building MCP servers on `@modelcontextprotocol/server` (SDK v2).
 * Import from here instead of the SDK directly: one centralised import point for every
 * server-building primitive, high-level (`McpServer`) and low-level (`Server`) alike.
 *
 * Usage:
 *   import { createMcpServer, TOOL_ANNOTATIONS, completable } from '@novorb/mcp-core/server';
 *   import * as z from 'zod/v4';
 *
 *   export function buildServer(): McpServer {
 *     const server = createMcpServer('my-mcp', '1.0.0');
 *     server.registerTool('lookup', {
 *       description: 'Look up data by key',
 *       inputSchema: z.object({ key: z.string() }),
 *       annotations: TOOL_ANNOTATIONS.readOnly,
 *     }, async ({ key }) => ({ content: [{ type: 'text', text: await lookup(key) }] }));
 *     server.registerPrompt('find', {
 *       argsSchema: z.object({ key: completable(z.string(), (v) => ['foo', 'bar'].filter((k) => k.startsWith(v))) }),
 *     }, ({ key }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Find ${key}` } }] }));
 *     return server;
 *   }
 *
 * An optional completable argument is written `completable(z.string(), cb).optional()`; the inverse
 * nesting `completable(z.string().optional(), cb)` silently yields no completions in SDK v2.
 */

import {
  type Implementation,
  McpServer,
  type McpServerOptions,
  type ServerCapabilities,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { resolveLimits } from './limits.js';
import { paginateLists } from './list-pagination.js';
import { enableProtocolLogging, protocolLoggingEnabled } from './protocol-logging.js';

export type {
  AuthInfo,
  CallToolResult as McpCallToolResult,
  Implementation,
  InputRequiredResult,
  McpServerOptions,
  OAuthTokenVerifier,
  ScopeChallengeHandler,
  ServerContext,
  ToolAnnotations as McpToolAnnotations,
} from '@modelcontextprotocol/server';
export {
  completable,
  fromJsonSchema,
  inputRequired,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  ProtocolError,
  ProtocolErrorCode,
  requireScopes,
  Server,
  UrlElicitationRequiredError,
} from '@modelcontextprotocol/server';

/**
 * Standard tool annotation presets.
 *
 * Pass one of these (or a spread of multiple) to `annotations` in `registerTool`.
 * These are HINTS; clients may or may not act on them.
 *
 * @example
 *   annotations: TOOL_ANNOTATIONS.readOnly
 *   annotations: { ...TOOL_ANNOTATIONS.readOnly, title: 'Domain lookup' }
 */
export const TOOL_ANNOTATIONS = {
  /** Read-only, safe-to-retry. Use for all lookup / search / status tools. */
  readOnly: { readOnlyHint: true, idempotentHint: true } satisfies ToolAnnotations,
  /** Write that is idempotent (calling N times = calling once). */
  idempotentWrite: { readOnlyHint: false, idempotentHint: true } satisfies ToolAnnotations,
  /** Mutating write that may behave differently on repeat calls. */
  mutableWrite: { readOnlyHint: false, idempotentHint: false } satisfies ToolAnnotations,
  /** Destructive / irreversible (delete, overwrite). */
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } satisfies ToolAnnotations,
  // The `*OpenWorld` variants add `openWorldHint: true`: use them for every tool that reaches an external
  // API or open system (most fleet tools), so all servers declare it the same way.
  /** `readOnly` + `openWorldHint` (lookups against an external API). */
  readOnlyOpenWorld: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  /** `idempotentWrite` + `openWorldHint`. */
  idempotentWriteOpenWorld: {
    readOnlyHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } satisfies ToolAnnotations,
  /** `mutableWrite` + `openWorldHint`. */
  mutableWriteOpenWorld: { readOnlyHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations,
  /** `destructive` + `openWorldHint`. */
  destructiveOpenWorld: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  } satisfies ToolAnnotations,
} as const;

/** mcp-core's default cache hints: tool lists are static per process, private while they may vary by caller. */
export const DEFAULT_CACHE_HINTS: NonNullable<McpServerOptions['cacheHints']> = {
  'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
};

/** `McpServerOptions` (the SDK's, passed through) plus mcp-core's own switches. */
export interface CreateMcpServerOptions extends McpServerOptions {
  /**
   * Page size for `tools/list` (and `prompts/list`, `resources/list`, `resources/templates/list`).
   * Default `MCP_LIST_PAGE_SIZE`, else 100; 0 disables list pagination.
   */
  listPageSize?: number;
  /**
   * Advertise the `logging` capability and forward logger entries to the client as MCP logging
   * notifications (deprecated by 2026-07-28, functional for at least twelve months). Default
   * `LOG_PROTOCOL`, else false.
   */
  protocolLogging?: boolean;
}

const LIST_CAPABILITIES = ['tools', 'prompts', 'resources'] as const;

/**
 * Create a pre-configured McpServer instance (call it inside the factory handed to `startMcpServer`:
 * in SDK v2 one instance serves one connection).
 *
 * Accepts the full `Implementation` (`name`, `version`, `title`, `description`, `websiteUrl`, `icons`)
 * or the `(name, version)` shorthand, and the SDK's `McpServerOptions` (`instructions`, `capabilities`,
 * `cacheHints`, `maxToolInputElements`, `inputRequired`, `requestState`, ...), with mcp-core defaults:
 *
 * - `cacheHints`: `tools/list` private for 5 minutes (`DEFAULT_CACHE_HINTS`), merged under yours;
 * - `maxToolInputElements`: `MCP_MAX_TOOL_INPUT_ELEMENTS`, else 10000;
 * - list pagination on (`listPageSize`);
 * - protocol logging off unless `protocolLogging` / `LOG_PROTOCOL`.
 *
 * List capabilities (`tools`, `prompts`, `resources`) passed in `capabilities` are registered after the
 * list pagination hook is in place; the SDK then installs the list handler on the first registration
 * (a capability declared with nothing registered is answered by no list handler).
 */
export function createMcpServer(info: Implementation, options?: CreateMcpServerOptions): McpServer;
export function createMcpServer(name: string, version: string, options?: CreateMcpServerOptions): McpServer;
export function createMcpServer(
  infoOrName: Implementation | string,
  versionOrOptions?: string | CreateMcpServerOptions,
  maybeOptions?: CreateMcpServerOptions,
): McpServer {
  const info: Implementation =
    typeof infoOrName === 'string' ? { name: infoOrName, version: String(versionOrOptions) } : infoOrName;
  const options = (typeof infoOrName === 'string' ? maybeOptions : (versionOrOptions as CreateMcpServerOptions)) ?? {};
  const { listPageSize, protocolLogging, capabilities, ...sdkOptions } = options;
  const limits = resolveLimits(listPageSize !== undefined ? { listPageSize } : {});
  const logging = protocolLoggingEnabled(protocolLogging);

  const constructorCaps: ServerCapabilities = { ...capabilities };
  const listCaps: ServerCapabilities = {};
  for (const key of LIST_CAPABILITIES) {
    if (constructorCaps[key] !== undefined) {
      Object.assign(listCaps, { [key]: constructorCaps[key] });
      delete constructorCaps[key];
    }
  }
  if (logging) constructorCaps.logging = {};

  const server = new McpServer(info, {
    ...sdkOptions,
    ...(Object.keys(constructorCaps).length > 0 ? { capabilities: constructorCaps } : {}),
    cacheHints: { ...DEFAULT_CACHE_HINTS, ...sdkOptions.cacheHints },
    maxToolInputElements: sdkOptions.maxToolInputElements ?? limits.maxToolInputElements,
  });
  paginateLists(server.server, limits.listPageSize);
  if (Object.keys(listCaps).length > 0) server.server.registerCapabilities(listCaps);
  if (logging) enableProtocolLogging();
  return server;
}
