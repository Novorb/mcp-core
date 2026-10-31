/**
 * @novorb/mcp-core/testing - a raw JSON-RPC peer, for wire shapes the SDK client does not accept.
 *
 * The SDK 2.3.1 `Client` refuses a 2026-07-28 `tools/call` answered with `resultType: "task"`
 * (typescript-sdk#2637; the requester side lives in `@modelcontextprotocol/ext-tasks`), so task tools
 * are exercised on the modern era with plain JSON-RPC. `rawPeer` drives any SDK client transport
 * (in memory, stdio); `rawHttpPeer` POSTs to a Streamable HTTP endpoint with the SEP-2243 headers.
 * `modernMeta` builds the per-request 2026-07-28 envelope.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  type JSONRPCMessage,
  PROTOCOL_VERSION_META_KEY,
  type Transport,
} from '@modelcontextprotocol/client';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** The `_meta` envelope of a 2026-07-28 request. */
export function modernMeta(capabilities: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
    [CLIENT_INFO_META_KEY]: { name: 'mcp-core-raw-peer', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: capabilities,
  };
}

/** A JSON-RPC response as received. */
export interface RawResponse {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface RawPeer {
  /** Send a request and resolve with its response (notifications before it are collected). */
  request(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<RawResponse>;
  /** Send a notification. */
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  /** Every notification received so far. */
  notifications: Array<{ method: string; params?: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** Drive an SDK client transport (started here) with raw JSON-RPC. */
export async function rawPeer(transport: Transport): Promise<RawPeer> {
  let nextId = 1;
  const pending = new Map<number | string, (response: RawResponse) => void>();
  const notifications: RawPeer['notifications'] = [];
  transport.onmessage = (message: JSONRPCMessage) => {
    const m = message as { id?: number | string; method?: string; params?: Record<string, unknown> } & RawResponse;
    if (m.method !== undefined && m.id === undefined) {
      notifications.push({ method: m.method, ...(m.params ? { params: m.params } : {}) });
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      const resolve = pending.get(m.id);
      pending.delete(m.id);
      resolve?.({ ...(m.result ? { result: m.result } : {}), ...(m.error ? { error: m.error } : {}) });
    }
  };
  await transport.start();
  return {
    notifications,
    request: (method, params, options) => {
      const id = nextId++;
      return new Promise<RawResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`raw peer: no response to ${method} within ${options?.timeoutMs ?? 10_000} ms`));
        }, options?.timeoutMs ?? 10_000);
        pending.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        transport.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } as JSONRPCMessage).catch(reject);
      });
    },
    notify: (method, params) =>
      transport.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) } as JSONRPCMessage),
    close: () => transport.close(),
  };
}

/** Headers SEP-2243 requires on a 2026-07-28 POST (`Mcp-Name` for tools/call and tasks/*). */
function modernHeaders(method: string, params: Record<string, unknown> | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
    'mcp-method': method,
  };
  const name = method === 'tools/call' ? params?.name : method.startsWith('tasks/') ? params?.taskId : undefined;
  if (typeof name === 'string') headers['mcp-name'] = name;
  return headers;
}

/** The last JSON-RPC message of a JSON or SSE body. */
export function parseRpcBody(contentType: string | null, text: string): RawResponse {
  const payload = contentType?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.includes('"id"'))
        .at(-1)
    : text;
  return JSON.parse(payload ?? '{}') as RawResponse;
}

/** POST one 2026-07-28 request per call to `url` (an MCP endpoint), with an optional Bearer key. */
export function rawHttpPeer(url: string, apiKey?: string): Pick<RawPeer, 'request'> {
  let nextId = 1;
  return {
    async request(method, params, options) {
      const headers = modernHeaders(method, params);
      if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(options?.timeoutMs ?? 10_000),
      });
      return parseRpcBody(res.headers.get('content-type'), await res.text());
    },
  };
}
