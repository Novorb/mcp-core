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

import { McpServer, type ToolAnnotations } from '@modelcontextprotocol/server';

export type {
  CallToolResult as McpCallToolResult,
  ToolAnnotations as McpToolAnnotations,
} from '@modelcontextprotocol/server';
export {
  completable,
  fromJsonSchema,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  Server,
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
} as const;

/**
 * Create a pre-configured McpServer instance.
 *
 * Thin wrapper kept so individual servers import only from @novorb/mcp-core. In SDK v2 one instance
 * serves one connection, so call this inside the factory handed to `startMcpServer`.
 */
export function createMcpServer(name: string, version: string): McpServer {
  return new McpServer({ name, version });
}
