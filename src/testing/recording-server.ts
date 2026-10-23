/**
 * @novorb/mcp-core/testing - a minimal stand-in for McpServer that records registered tools and
 * prompts, so unit tests can invoke their handlers directly without the MCP protocol.
 *
 * Behaviour (unchanged from the per-server copies it replaces): `registerTool` / `registerPrompt` store
 * `{ name, config, handler }` under the name (a later registration with the same name replaces the
 * earlier one) and return a handle whose `remove()` deletes it. Nothing is validated and nothing else
 * of McpServer is implemented.
 */

import type { ClientCapabilities, GetPromptResult } from '@modelcontextprotocol/server';
import type { McpCallToolResult, McpServer } from '../server.js';

/** Handler signature as recorded; call it with the tool arguments (and optionally a request extra). */
export type RecordedToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<McpCallToolResult>;
export type RecordedPromptHandler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => GetPromptResult | Promise<GetPromptResult>;

/** The tool/prompt config as passed to register*: description, schemas, annotations, ... */
export type RecordedConfig = Record<string, unknown>;

export interface CapturedTool {
  name: string;
  config: RecordedConfig;
  handler: RecordedToolHandler;
}

export interface CapturedPrompt {
  name: string;
  config: RecordedConfig;
  handler: RecordedPromptHandler;
}

export interface RecordingServer {
  tools: Map<string, CapturedTool>;
  prompts: Map<string, CapturedPrompt>;
  /** Cast to McpServer for passing into register* functions. */
  asMcpServer(): McpServer;
}

export interface RecordingServerOptions {
  /** What `server.getClientCapabilities()` answers (the `ToolContext` client input helpers read it). */
  clientCapabilities?: ClientCapabilities;
}

export function makeRecordingServer(options: RecordingServerOptions = {}): RecordingServer {
  const tools = new Map<string, CapturedTool>();
  const prompts = new Map<string, CapturedPrompt>();

  const server = {
    server: { getClientCapabilities: (): ClientCapabilities | undefined => options.clientCapabilities },
    registerTool(name: string, config: RecordedConfig, handler: RecordedToolHandler) {
      tools.set(name, { name, config, handler });
      return {
        remove() {
          tools.delete(name);
        },
      };
    },
    registerPrompt(name: string, config: RecordedConfig, handler: RecordedPromptHandler) {
      prompts.set(name, { name, config, handler });
      return {
        remove() {
          prompts.delete(name);
        },
      };
    },
  };

  return {
    tools,
    prompts,
    asMcpServer: () => server as unknown as McpServer,
  };
}
