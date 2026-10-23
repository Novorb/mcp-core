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
