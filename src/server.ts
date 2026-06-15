/**
 * @novorb/mcp-core — Server
 *
 * Re-exports and base patterns for building MCP servers with the high-level McpServer API.
 * Import from here instead of the SDK directly — one centralised import point for all
 * server-building primitives.
 *
 * Usage:
 *   import { createMcpServer, TOOL_ANNOTATIONS, completable } from '@novorb/mcp-core/server';
 *   import type { McpToolAnnotations, McpCallToolResult } from '@novorb/mcp-core/server';
 *
 *   const server = createMcpServer('my-mcp', '1.0.0');
 *
 *   server.registerTool('lookup', {
 *     description: 'Look up data by key',
 *     inputSchema: { key: z.string() },
 *     outputSchema: { value: z.string(), found: z.boolean() },
 *     annotations: TOOL_ANNOTATIONS.readOnly,
 *   }, async ({ key }) => {
 *     const value = await lookup(key);
 *     return {
 *       content: [{ type: 'text', text: value ?? 'not found' }],
 *       structuredContent: { value: value ?? '', found: value !== null },
 *     };
 *   });
 *
 *   server.registerPrompt('find-and-summarise', {
 *     title: 'Find and summarise',
 *     description: 'Look up a key and summarise the value',
 *     argsSchema: { key: completable(z.string(), val => ['foo', 'bar'].filter(k => k.startsWith(val))) },
 *   }, ({ key }) => ({
 *     messages: [{ role: 'user', content: { type: 'text', text: `Look up "${key}" and summarise the result.` } }],
 *   }));
 */

// ---------------------------------------------------------------------------
// Re-exports — individual servers import ONLY from @novorb/mcp-core
// ---------------------------------------------------------------------------

export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { completable } from '@modelcontextprotocol/sdk/server/completable.js';
export type { ToolAnnotations as McpToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
export type { CallToolResult as McpCallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Annotation presets — covers the common tool categories
// ---------------------------------------------------------------------------

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * Standard tool annotation presets.
 *
 * Pass one of these (or a spread of multiple) to `annotations` in `registerTool`.
 * These are HINTS — clients may or may not act on them.
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Create a pre-configured McpServer instance.
 *
 * Thin wrapper kept so individual servers import only from @novorb/mcp-core and
 * don't carry a direct @modelcontextprotocol/sdk import.
 */
export function createMcpServer(name: string, version: string): McpServer {
  return new McpServer({ name, version });
}
