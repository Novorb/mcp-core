/**
 * @novorb/mcp-core/testing - client construction shared by every harness entry point.
 */

import { Client, type ClientOptions } from '@modelcontextprotocol/client';

/**
 * Protocol era the test client negotiates.
 * - `legacy`: the SDK client default (a 2025-era protocol version).
 * - `modern`: `versionNegotiation: { mode: 'auto' }`, which selects 2026-07-28 when the server supports it.
 */
export type ProtocolEra = 'legacy' | 'modern';

/** Options every harness entry point accepts for the v2 client it builds. */
export interface TestClientOptions {
  /** Protocol era (default `legacy`). Ignored when `clientOptions.versionNegotiation` is set. */
  era?: ProtocolEra;
  /** Client name/version announced to the server (default `mcp-core-testing` / `1.0.0`). */
  clientInfo?: { name: string; version: string };
  /** Extra SDK client options, merged over the era default. */
  clientOptions?: ClientOptions;
}

/** Build a v2 `Client` for the given era. */
export function createTestClient(options: TestClientOptions = {}): Client {
  const info = options.clientInfo ?? { name: 'mcp-core-testing', version: '1.0.0' };
  const eraOptions: ClientOptions = options.era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {};
  return new Client(info, { ...eraOptions, ...options.clientOptions });
}
