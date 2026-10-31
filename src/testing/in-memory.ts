/**
 * @novorb/mcp-core/testing - connect a v2 client to a server factory in-process over the SDK's
 * linked in-memory transport pair (no child process, no socket).
 *
 * The server side is the SDK's `serveStdio` connection owner with the in-memory transport as its wire,
 * so the client's opening message selects the protocol era exactly as it does over real stdio (both
 * the 2025 and the 2026-07-28 era work).
 */

import { type Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ServerEventBus } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { processBus } from '../notifications.js';
import { notifyingFactory, type ServerFactory } from '../transport.js';
import { createTestClient, type TestClientOptions } from './client.js';

export interface InMemoryConnection {
  client: Client;
  /** Close the client and the server side. Idempotent; never throws. */
  close(): Promise<void>;
}

export interface ConnectInMemoryOptions extends TestClientOptions {
  /** Out-of-band server errors (default: ignored). */
  onServerError?: (error: Error) => void;
  /** The change-event bus the connection's instance forwards (default the process bus), as on stdio. */
  bus?: ServerEventBus;
}

/** Link `factory` to a fresh v2 client in memory and connect it. */
export async function connectInMemory(
  factory: ServerFactory,
  options: ConnectInMemoryOptions = {},
): Promise<InMemoryConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(notifyingFactory(factory, options.bus ?? processBus()), {
    transport: serverTransport,
    onerror: options.onServerError,
  });
  const client = createTestClient(options);
  try {
    await client.connect(clientTransport);
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e;
  }
  let closing: Promise<void> | undefined;
  return {
    client,
    close: () => {
      closing ??= (async () => {
        await client.close().catch(() => undefined);
        await handle.close().catch(() => undefined);
      })();
      return closing;
    },
  };
}
