/**
 * @novorb/mcp-core/testing - a minimal fetch wrapper for adverse HTTP checks (401, 404, 413, 415, ...).
 */

export interface RawHttpOptions {
  /** HTTP method (default `POST`). */
  method?: string;
  headers?: Record<string, string>;
  /** Request body (use `'x'.repeat(n)` for an oversized body). */
  body?: string;
  /** Abort after this many milliseconds (default 10000). */
  timeoutMs?: number;
}

export interface RawHttpResponse {
  status: number;
  /** Response headers, names lower-cased. */
  headers: Record<string, string>;
  text: string;
}

/** Send one request and return status, headers and body text. Network errors throw. */
export async function rawHttp(url: string, options: RawHttpOptions = {}): Promise<RawHttpResponse> {
  const res = await fetch(url, {
    method: options.method ?? 'POST',
    headers: options.headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: res.status, headers, text: await res.text() };
}

/** A JSON-RPC `initialize` request body (2025-06-18), for raw requests that must reach the MCP handler. */
export function initializeRequestBody(id = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-core-testing-raw', version: '1.0.0' },
    },
  });
}

/** Headers a Streamable HTTP POST needs (`content-type` + `accept`), plus an optional Bearer key. */
export function mcpPostHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}
