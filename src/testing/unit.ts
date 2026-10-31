/**
 * @novorb/mcp-core/testing - in-process UNIT helpers: call a server's tools by name over the in-memory
 * transport (no child process, no network) and assert on the outcome without a test-runner import.
 *
 * Observed SDK v2 behaviour for an McpServer (pinned by mcp-core's own tests):
 * - arguments that fail the tool's inputSchema come back as a RESULT with `isError: true` and text
 *   starting `Input validation error:`;
 * - an unknown tool name is a THROWN ProtocolError, code -32602 (InvalidParams), `Tool <name> not found`.
 * Low-level `Server` consumers may surface either one either way, so the helpers accept both.
 */

import type { Client } from '@modelcontextprotocol/client';
import type { ServerFactory } from '../transport.js';
import type { TestClientOptions } from './client.js';
import { connectInMemory } from './in-memory.js';
import { callToolJson, type ToolJsonResult } from './tools.js';

/** JSON-RPC InvalidParams: the code the SDK uses for unknown tools (and some schema rejections). */
export const INVALID_PARAMS_CODE = -32602;

/** Run `fn` with a client connected in memory to `factory`; always closes. */
export async function withInMemoryClient<R>(
  factory: ServerFactory,
  fn: (client: Client) => Promise<R>,
  options: TestClientOptions = {},
): Promise<R> {
  const conn = await connectInMemory(factory, options);
  try {
    return await fn(conn.client);
  } finally {
    await conn.close();
  }
}

/** Build a server from `factory`, call one tool in memory, decode the result, and close. */
export async function callToolInMemory<T = unknown>(
  factory: ServerFactory,
  name: string,
  args: Record<string, unknown> = {},
  options: TestClientOptions = {},
): Promise<ToolJsonResult<T>> {
  return withInMemoryClient(factory, (client) => callToolJson<T>(client, name, args), options);
}

/** The outcome of a call that may either return a result or throw a protocol error. */
export type ToolOutcome<T = unknown> =
  | { kind: 'result'; result: ToolJsonResult<T> }
  | { kind: 'protocol-error'; code: number | undefined; message: string };

/** Call a tool and capture a thrown protocol error as data instead of rethrowing it. */
export async function captureToolCall<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome<T>> {
  try {
    return { kind: 'result', result: await callToolJson<T>(client, name, args) };
  } catch (e) {
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
    return {
      kind: 'protocol-error',
      code: typeof code === 'number' ? code : undefined,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

function matches(text: string, pattern: string | RegExp | undefined): boolean {
  if (pattern === undefined) return true;
  return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
}

/** Throw unless `result.isError` is true (and its text matches `pattern`); returns the error text. */
export function expectToolError(result: ToolJsonResult, pattern?: string | RegExp): string {
  if (!result.isError) {
    throw new Error(`Expected an isError result, got success: ${result.text.slice(0, 200)}`);
  }
  if (!matches(result.text, pattern)) {
    throw new Error(`isError text did not match ${String(pattern)}: ${result.text.slice(0, 200)}`);
  }
  return result.text;
}

/** Throw unless the result is a success; returns the decoded body. */
export function expectToolSuccess<T>(result: ToolJsonResult<T>): T {
  if (result.isError) throw new Error(`Expected success, got isError: ${result.text.slice(0, 200)}`);
  return result.body;
}

export interface Rejection {
  /** How the rejection surfaced. */
  via: 'tool-error' | 'protocol-error';
  message: string;
}

/**
 * Call a tool with arguments its schema must reject and throw unless it was rejected: an isError result
 * (`Input validation error` on McpServer) or an InvalidParams protocol error.
 */
export async function expectSchemaRejection(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Rejection> {
  const outcome = await captureToolCall(client, name, args);
  if (outcome.kind === 'protocol-error') {
    if (outcome.code !== INVALID_PARAMS_CODE) {
      throw new Error(
        `Expected a schema rejection (code ${INVALID_PARAMS_CODE}), got code ${outcome.code}: ${outcome.message}`,
      );
    }
    return { via: 'protocol-error', message: outcome.message };
  }
  if (!outcome.result.isError) {
    throw new Error(`Expected ${name} to reject its arguments, but it succeeded`);
  }
  return { via: 'tool-error', message: outcome.result.text };
}

/**
 * Call a tool name the server does not have and throw unless it was refused: a protocol error, or an
 * isError result whose text says the tool is unknown / not found (any other error result, such as a
 * schema rejection of an EXISTING tool, does not count).
 */
export async function expectUnknownTool(client: Client, name: string): Promise<Rejection> {
  const outcome = await captureToolCall(client, name, {});
  if (outcome.kind === 'protocol-error') return { via: 'protocol-error', message: outcome.message };
  if (outcome.result.isError && /unknown|not found/i.test(outcome.result.text)) {
    return { via: 'tool-error', message: outcome.result.text };
  }
  throw new Error(`Expected unknown tool ${name} to be refused, got: ${outcome.result.text.slice(0, 200)}`);
}
