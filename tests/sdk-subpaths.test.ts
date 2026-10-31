import { describe, expect, it } from '@jest/globals';
import * as client from '@novorb/mcp-core/sdk/client';
import * as clientStdio from '@novorb/mcp-core/sdk/client/stdio';
import * as sdkExpress from '@novorb/mcp-core/sdk/express';
import * as node from '@novorb/mcp-core/sdk/node';
import * as server from '@novorb/mcp-core/sdk/server';
import * as serverStdio from '@novorb/mcp-core/sdk/server/stdio';

// The SDK subpaths are full `export *` re-exports: a consumer reaches every SDK feature through
// mcp-core. These pin the entry points consumers use, not the whole export list.
describe('SDK re-export subpaths', () => {
  it('sdk/server carries McpServer, createMcpHandler, inputRequired and the auth helpers', () => {
    for (const name of [
      'McpServer',
      'Server',
      'createMcpHandler',
      'inputRequired',
      'verifyBearerToken',
      'requireScopes',
    ]) {
      expect(typeof (server as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('sdk/server/stdio, sdk/node and sdk/express carry their serving entries', () => {
    expect(typeof serverStdio.serveStdio).toBe('function');
    expect(typeof serverStdio.StdioServerTransport).toBe('function');
    expect(typeof node.toNodeHandler).toBe('function');
    expect(typeof sdkExpress.requireBearerAuth).toBe('function');
    expect(typeof sdkExpress.createMcpExpressApp).toBe('function');
  });

  it('sdk/client and sdk/client/stdio carry the client and its transports', () => {
    expect(typeof client.Client).toBe('function');
    expect(typeof client.StreamableHTTPClientTransport).toBe('function');
    expect(typeof client.InMemoryTransport).toBe('function');
    expect(typeof clientStdio.StdioClientTransport).toBe('function');
  });
});
