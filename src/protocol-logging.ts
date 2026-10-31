/**
 * @novorb/mcp-core - Protocol logging (MCP `notifications/message`)
 *
 * Forwards mcp-core logger entries to the MCP client as logging notifications while a request is being
 * handled, through the SDK's own `ctx.mcpReq.log(level, data, logger)`. The SDK decides per era:
 *
 * - 2025-era connections honour the client's `logging/setLevel` (stdio keeps the level for the
 *   connection; stateless HTTP builds a fresh instance per request, so a level set in one request is
 *   not seen by the next one and every level is sent);
 * - 2026-07-28 requests emit only when the request carries the per-request log level
 *   (`_meta['io.modelcontextprotocol/logLevel']`), never otherwise.
 *
 * Protocol logging is deprecated by the 2026-07-28 revision (SEP-2577) but remains functional for at
 * least twelve months, and 2025 clients use it, so it stays available as an opt-in: `LOG_PROTOCOL=true`
 * (or `createMcpServer(..., { protocolLogging: true })`) advertises the `logging` capability and
 * installs the forwarder. Default off.
 *
 * What is forwarded is exactly what the log files receive (redacted, PII-masked, registered secret
 * values masked), and the logger never carries tool inputs or outputs (`logToolCall` is shape only).
 * The request is found through an AsyncLocalStorage scope that `registerTools` opens around every
 * handler (or `runWithRequestContext` for hand-registered handlers).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LoggingLevel, ServerContext } from '@modelcontextprotocol/server';
import { addLogListener, type LogEntry, LogLevel } from './utils/logger.js';

const requestScope = new AsyncLocalStorage<ServerContext>();

/** Run `fn` with `ctx` as the current request (what the protocol log forwarder sends through). */
export function runWithRequestContext<T>(ctx: ServerContext, fn: () => T): T {
  return requestScope.run(ctx, fn);
}

/** The SDK handler context of the request being handled, if any. */
export function currentRequestContext(): ServerContext | undefined {
  return requestScope.getStore();
}

const LEVEL_MAP: Record<LogLevel, LoggingLevel> = {
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARN]: 'warning',
  [LogLevel.ERROR]: 'error',
};

/** The MCP logging level for an mcp-core log level. */
export function toMcpLoggingLevel(level: LogLevel): LoggingLevel {
  return LEVEL_MAP[level];
}

function parseBool(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return undefined;
}

/** Whether protocol logging is on: the explicit option, else `LOG_PROTOCOL`, else false. */
export function protocolLoggingEnabled(option?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return option ?? parseBool(env.LOG_PROTOCOL) ?? false;
}

let unsubscribe: (() => void) | undefined;

function forward(entry: LogEntry): void {
  const ctx = currentRequestContext();
  if (!ctx) return;
  const data: Record<string, unknown> = { message: entry.message, context: entry.context };
  if (entry.meta !== undefined) data.meta = entry.meta;
  // The SDK applies the capability, the era and the client's level; a failed send never surfaces.
  ctx.mcpReq.log(toMcpLoggingLevel(entry.level), data, entry.logger).catch(() => undefined);
}

/** Install the forwarder (idempotent). `createMcpServer` calls this when protocol logging is on. */
export function enableProtocolLogging(): void {
  // The listener set dedupes `forward`, so this stays idempotent (and survives a `resetLogger`).
  unsubscribe = addLogListener(forward);
}

/** Remove the forwarder (tests). */
export function disableProtocolLogging(): void {
  unsubscribe?.();
  unsubscribe = undefined;
}
