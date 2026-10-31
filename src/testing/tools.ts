/**
 * @novorb/mcp-core/testing - tool call and tool coverage helpers over a connected v2 client.
 */

import type { CallToolResult, Client } from '@modelcontextprotocol/client';

export interface ToolJsonResult<T = unknown> {
  /** `result.isError === true`. */
  isError: boolean;
  /**
   * `structuredContent` when the tool returned it; otherwise the first text block parsed as JSON, or the
   * raw text when it is not JSON; `undefined` when there is neither.
   */
  body: T;
  /** The first text block ('' when there is none). */
  text: string;
  /** The unmodified SDK result. */
  raw: CallToolResult;
}

function firstText(result: CallToolResult): string {
  for (const block of result.content ?? []) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

/**
 * Call a tool and decode its body. Tool-level failures come back as `isError: true` (not a throw);
 * protocol errors (unknown tool, schema rejection on some servers) throw from the SDK as usual.
 */
export async function callToolJson<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolJsonResult<T>> {
  const raw = await client.callTool({ name, arguments: args });
  const text = firstText(raw);
  let body: unknown;
  if (raw.structuredContent !== undefined) {
    body = raw.structuredContent;
  } else if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { isError: raw.isError === true, body: body as T, text, raw };
}

/** Names of every tool the server lists (all pages), in server order. */
export async function listToolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
}

export interface ToolCoverage {
  /** Tools the server lists that have no case. */
  missing: string[];
  /** Cases naming a tool the server does not list. */
  stale: string[];
  /** Case names that appear more than once. */
  duplicates: string[];
  /** True when all three lists are empty. */
  ok: boolean;
}

/** Compare the server's tool names with the suite's case names, both directions. Sorted output. */
export function toolCoverage(actualNames: readonly string[], caseNames: readonly string[]): ToolCoverage {
  const actual = new Set(actualNames);
  const cases = new Set<string>();
  const dup = new Set<string>();
  for (const c of caseNames) {
    if (cases.has(c)) dup.add(c);
    cases.add(c);
  }
  const missing = [...actual].filter((n) => !cases.has(n)).sort();
  const stale = [...cases].filter((n) => !actual.has(n)).sort();
  const duplicates = [...dup].sort();
  return { missing, stale, duplicates, ok: missing.length === 0 && stale.length === 0 && duplicates.length === 0 };
}

/** `toolCoverage`, throwing an Error that lists every gap when the sets differ. */
export function assertToolCoverage(actualNames: readonly string[], caseNames: readonly string[]): ToolCoverage {
  const cov = toolCoverage(actualNames, caseNames);
  if (!cov.ok) {
    const parts = [
      `tools without a case: [${cov.missing.join(', ')}]`,
      `stale cases (no such tool): [${cov.stale.join(', ')}]`,
    ];
    if (cov.duplicates.length > 0) parts.push(`duplicate cases: [${cov.duplicates.join(', ')}]`);
    throw new Error(`Tool coverage mismatch: ${parts.join('; ')}`);
  }
  return cov;
}

export interface ToolWire {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execution?: unknown;
}

const WIRE_KEYS = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations', 'execution'] as const;

/**
 * The server's `tools/list` surface across every page, reduced to the wire fields, sorted by name and
 * round-tripped through JSON so it compares stably against a stored fixture.
 */
export async function captureToolWire(client: Client): Promise<ToolWire[]> {
  const wire: ToolWire[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    for (const tool of page.tools) {
      const entry: Record<string, unknown> = {};
      for (const key of WIRE_KEYS) {
        const value = (tool as Record<string, unknown>)[key];
        if (value !== undefined) entry[key] = value;
      }
      wire.push(entry as unknown as ToolWire);
    }
    cursor = page.nextCursor;
    if (cursor === '') throw new Error('captureToolWire: tools/list returned an empty nextCursor');
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error('captureToolWire: tools/list returned a repeated nextCursor');
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  wire.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.parse(JSON.stringify(wire)) as ToolWire[];
}
