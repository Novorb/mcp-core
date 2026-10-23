/**
 * @novorb/mcp-core - Response limits
 *
 * The caps mcp-core enforces by default on what one response may carry, resolved from the env (an
 * explicit option wins; an invalid value falls back to the default):
 *
 *   MCP_LIST_PAGE_SIZE           tools/list (and prompts/resources lists) page size; 0 = no pagination (100)
 *   MCP_MAX_RESULT_ITEMS         items per list-shaped tool result, and per http-client collect (100)
 *   MCP_MAX_RESULT_BYTES         serialized bytes per tool result (262144)
 *   MCP_MAX_TOOL_INPUT_ELEMENTS  array elements + object members per tools/call arguments payload (10000)
 */

/** Default list page size: large enough that the biggest fleet server (51 tools) fits one page. */
export const DEFAULT_LIST_PAGE_SIZE = 100;
export const DEFAULT_MAX_RESULT_ITEMS = 100;
export const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
export const DEFAULT_MAX_TOOL_INPUT_ELEMENTS = 10_000;
/** Upper bound for an explicit http-client `maxItems` (bounded memory whatever the caller asks). */
export const HARD_MAX_COLLECT_ITEMS = 100_000;

export interface ResponseLimits {
  /** 0 disables list pagination. */
  listPageSize: number;
  maxResultItems: number;
  maxResultBytes: number;
  maxToolInputElements: number;
}

function parseCount(value: string | undefined, fallback: number, allowZero: boolean): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || (n === 0 && !allowZero)) return fallback;
  return n;
}

/** The limits from `env` (default `process.env`), with `overrides` winning. */
export function resolveLimits(
  overrides: Partial<ResponseLimits> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResponseLimits {
  return {
    listPageSize: overrides.listPageSize ?? parseCount(env.MCP_LIST_PAGE_SIZE, DEFAULT_LIST_PAGE_SIZE, true),
    maxResultItems: overrides.maxResultItems ?? parseCount(env.MCP_MAX_RESULT_ITEMS, DEFAULT_MAX_RESULT_ITEMS, false),
    maxResultBytes: overrides.maxResultBytes ?? parseCount(env.MCP_MAX_RESULT_BYTES, DEFAULT_MAX_RESULT_BYTES, false),
    maxToolInputElements:
      overrides.maxToolInputElements ??
      parseCount(env.MCP_MAX_TOOL_INPUT_ELEMENTS, DEFAULT_MAX_TOOL_INPUT_ELEMENTS, false),
  };
}
