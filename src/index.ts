/**
 * @novorb/mcp-core
 *
 * Shared utilities for MCP servers.
 */

// Logger
export {
  Logger,
  LogLevel,
  initLogger,
  getLogger,
  resetLogger,
  type LoggerConfig,
} from './logger.js';

// Retry
export {
  retryWithBackoff,
  calculateRetryDelay,
  isRetryableError,
  sleep,
  parseRetryAfter,
  type RetryOptions,
  type RetryContext,
} from './retry.js';

// Pagination
export {
  normalizePagination,
  createPaginationMetadata,
  pageToOffset,
  paginateArray,
  type PaginationParams,
  type NormalizedPagination,
  type PaginationMetadata,
} from './pagination.js';

// HTTP Client
export {
  McpHttpClient,
  createHttpClient,
  type HttpClientConfig,
  type PaginatedResponse,
} from './http-client.js';

// Transport
export {
  startMcpServer,
  type TransportMode,
  type TransportOptions,
} from './transport.js';

// Server builder (McpServer patterns, re-exports, annotation presets)
export {
  McpServer,
  completable,
  createMcpServer,
  TOOL_ANNOTATIONS,
  type McpToolAnnotations,
  type McpCallToolResult,
} from './server.js';
