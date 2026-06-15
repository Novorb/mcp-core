/**
 * @novorb/mcp-core — HTTP Client Factory
 *
 * Creates pre-configured axios instances with retry logic and logging.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { getLogger, Logger } from './logger.js';

export interface HttpClientConfig {
  /** Base URL for all requests */
  baseURL: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Default headers to include on every request */
  headers?: Record<string, string>;
  /** Number of retries on retryable failures (default: 3) */
  retries?: number;
  /** Logger instance (default: singleton from getLogger) */
  logger?: Logger;
  /** Component name for log messages (default: 'HttpClient') */
  logContext?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  totalCount: number;
}

/**
 * MCP HTTP client wrapping axios with retry, logging, and pagination support.
 */
export class McpHttpClient {
  private client: AxiosInstance;
  private logger: Logger;
  private logContext: string;

  constructor(config: HttpClientConfig) {
    this.logger = config.logger || getLogger();
    this.logContext = config.logContext || 'HttpClient';

    this.client = axios.create({
      baseURL: config.baseURL,
      timeout: config.timeout || 30000,
      // Never follow redirects: the instance carries a static Authorization header, and axios re-sends
      // request data to a 3xx Location — a malicious/compromised upstream could harvest the credential.
      maxRedirects: 0,
      // Cap response/request size (OOM/DoS guard).
      maxContentLength: 25 * 1024 * 1024,
      maxBodyLength: 25 * 1024 * 1024,
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
    });

    axiosRetry(this.client, {
      retries: config.retries ?? 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        // Network/idempotent-request errors are already method-safe. Only ALSO retry 429/5xx for
        // idempotent methods — never replay a non-idempotent POST/PATCH (duplicate side effects).
        if (axiosRetry.isNetworkOrIdempotentRequestError(error)) return true;
        const method = (error.config?.method ?? 'get').toLowerCase();
        const idempotent = ['get', 'head', 'options', 'put', 'delete'].includes(method);
        const status = error.response?.status;
        const retryableStatus = status === 429 || (status !== undefined && status >= 500);
        return idempotent && retryableStatus;
      },
    });
  }

  /**
   * Perform a GET request.
   */
  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const startTime = Date.now();
    this.logger.debug(`GET ${path}`, this.logContext, { params });

    try {
      const response = await this.client.get<T>(path, { params });
      const duration = Date.now() - startTime;
      this.logger.debug(`GET ${path} completed`, this.logContext, {
        status: response.status,
        duration: `${duration}ms`,
      });
      return response.data;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`GET ${path} failed`, this.logContext, {
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.normalizeError(error);
    }
  }

  /**
   * Perform a GET request with pagination.
   * Reads total count from the X-Total-Count response header.
   */
  async getPaginated<T>(
    path: string,
    params?: Record<string, unknown>
  ): Promise<PaginatedResponse<T>> {
    const startTime = Date.now();
    this.logger.debug(`GET (paginated) ${path}`, this.logContext, { params });

    try {
      const response = await this.client.get<T[]>(path, { params });
      const totalCount = parseInt(response.headers['x-total-count'] || '0', 10);
      const duration = Date.now() - startTime;
      this.logger.debug(`GET (paginated) ${path} completed`, this.logContext, {
        status: response.status,
        totalCount,
        resultCount: response.data.length,
        duration: `${duration}ms`,
      });
      return { data: response.data, totalCount };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`GET (paginated) ${path} failed`, this.logContext, {
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.normalizeError(error);
    }
  }

  /**
   * Perform a POST request.
   */
  async post<T>(path: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
    const startTime = Date.now();
    this.logger.debug(`POST ${path}`, this.logContext);

    try {
      const response = await this.client.post<T>(path, data, { params });
      const duration = Date.now() - startTime;
      this.logger.debug(`POST ${path} completed`, this.logContext, {
        status: response.status,
        duration: `${duration}ms`,
      });
      return response.data;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`POST ${path} failed`, this.logContext, {
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.normalizeError(error);
    }
  }

  /**
   * Perform a PUT request.
   */
  async put<T>(path: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
    const startTime = Date.now();
    this.logger.debug(`PUT ${path}`, this.logContext);

    try {
      const response = await this.client.put<T>(path, data, { params });
      const duration = Date.now() - startTime;
      this.logger.debug(`PUT ${path} completed`, this.logContext, {
        status: response.status,
        duration: `${duration}ms`,
      });
      return response.data;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`PUT ${path} failed`, this.logContext, {
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.normalizeError(error);
    }
  }

  /**
   * Perform a PATCH request.
   */
  async patch<T>(path: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
    const startTime = Date.now();
    this.logger.debug(`PATCH ${path}`, this.logContext);

    try {
      const response = await this.client.patch<T>(path, data, { params });
      const duration = Date.now() - startTime;
      this.logger.debug(`PATCH ${path} completed`, this.logContext, {
        status: response.status,
        duration: `${duration}ms`,
      });
      return response.data;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`PATCH ${path} failed`, this.logContext, {
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.normalizeError(error);
    }
  }

  /**
   * Perform a DELETE request.
   */
  async delete<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const startTime = Date.now();
    this.logger.debug(`DELETE ${path}`, this.logContext);

    try {
      const response = await this.client.delete<T>(path, { params });
      const duration = Date.now() - startTime;
      this.logger.debug(`DELETE ${path} completed`, this.logContext, {
        status: response.status,
        duration: `${duration}ms`,
      });
      return response.data;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`DELETE ${path} failed`, this.logContext, {
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.normalizeError(error);
    }
  }

  /**
   * Get the underlying axios instance for advanced use cases.
   */
  getAxiosInstance(): AxiosInstance {
    return this.client;
  }

  private normalizeError(error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const statusText = error.response?.statusText;
      const data = error.response?.data;
      const message = typeof data === 'object' && data?.message
        ? data.message
        : `HTTP ${status} ${statusText}`;
      const normalized = new Error(message);
      // Attach only the status — NOT the raw axios `response`. Its `config` carries the request's
      // Authorization header/token, and the upstream response headers may carry set-cookie/auth
      // echoes; a consumer logging the thrown error would otherwise leak them.
      (normalized as unknown as Record<string, unknown>).status = status;
      (normalized as unknown as Record<string, unknown>).statusText = statusText;
      return normalized;
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Create a configured HTTP client.
 */
export function createHttpClient(config: HttpClientConfig): McpHttpClient {
  return new McpHttpClient(config);
}
