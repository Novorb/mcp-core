import * as z from 'zod/v4';
import { createMcpServer, type McpServer, TOOL_ANNOTATIONS } from '../../src/server.js';

/** A minimal server factory with one `echo` tool, shared by the stdio and HTTP round-trip tests. */
export function buildEchoServer(): McpServer {
  const server = createMcpServer('echo-fixture', '1.0.0');
  server.registerTool(
    'echo',
    {
      description: 'Echo the input text back',
      inputSchema: z.object({ text: z.string() }),
      annotations: TOOL_ANNOTATIONS.readOnly,
    },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
  );
  return server;
}
