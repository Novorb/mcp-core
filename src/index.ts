/**
 * @novorb/mcp-core
 *
 * Shared utilities for MCP servers.
 */

// HTTP Client
export {
  createHttpClient,
  type HttpClientConfig,
  McpHttpClient,
  type PaginatedResponse,
} from './http-client.js';
// Logger
export {
  getLogger,
  initLogger,
  Logger,
  type LoggerConfig,
  LogLevel,
  resetLogger,
} from './logger.js';

// Pagination
export {
  createPaginationMetadata,
  type NormalizedPagination,
  normalizePagination,
  type PaginationMetadata,
  type PaginationParams,
  pageToOffset,
  paginateArray,
} from './pagination.js';
// Retry
export {
  calculateRetryDelay,
  isRetryableError,
  parseRetryAfter,
  type RetryContext,
  type RetryOptions,
  retryWithBackoff,
  sleep,
} from './retry.js';
// Server builder (McpServer patterns, re-exports, annotation presets)
export {
  completable,
  createMcpServer,
  type McpCallToolResult,
  McpServer,
  type McpToolAnnotations,
  TOOL_ANNOTATIONS,
} from './server.js';
// Transport
export {
  startMcpServer,
  type TransportMode,
  type TransportOptions,
} from './transport.js';
