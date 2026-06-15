import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { resetLogger } from '../src/logger.js';

const mockGet = jest.fn<() => Promise<any>>();
const mockPost = jest.fn<() => Promise<any>>();
const mockPut = jest.fn<() => Promise<any>>();
const mockPatch = jest.fn<() => Promise<any>>();
const mockDelete = jest.fn<() => Promise<any>>();

const mockInstance = {
  get: mockGet,
  post: mockPost,
  put: mockPut,
  patch: mockPatch,
  delete: mockDelete,
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  },
};

jest.unstable_mockModule('axios', () => ({
  default: {
    create: jest.fn(() => mockInstance),
    isAxiosError: jest.fn((err: any) => err?.isAxiosError === true),
  },
}));

const mockIsNetworkOrIdempotent = jest.fn<any>(() => false);
const mockAxiosRetry: any = jest.fn();
mockAxiosRetry.exponentialDelay = jest.fn();
mockAxiosRetry.isNetworkOrIdempotentRequestError = mockIsNetworkOrIdempotent;
jest.unstable_mockModule('axios-retry', () => ({ default: mockAxiosRetry }));

// Dynamic import AFTER mocks are set up
const { McpHttpClient, createHttpClient } = await import('../src/http-client.js');

describe('McpHttpClient', () => {
  beforeEach(() => {
    resetLogger();
    jest.clearAllMocks();
  });

  describe('get', () => {
    it('should perform GET and return data', async () => {
      mockGet.mockResolvedValue({ status: 200, data: { id: 1 } });

      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      const result = await client.get('/items/1');

      expect(mockGet).toHaveBeenCalledWith('/items/1', { params: undefined });
      expect(result).toEqual({ id: 1 });
    });

    it('should pass query params', async () => {
      mockGet.mockResolvedValue({ status: 200, data: [] });

      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      await client.get('/items', { page: 1 });

      expect(mockGet).toHaveBeenCalledWith('/items', { params: { page: 1 } });
    });
  });

  describe('getPaginated', () => {
    it('should return data and totalCount from headers', async () => {
      mockGet.mockResolvedValue({
        status: 200,
        data: [{ id: 1 }, { id: 2 }],
        headers: { 'x-total-count': '42' },
      });

      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      const result = await client.getPaginated('/items');

      expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
      expect(result.totalCount).toBe(42);
    });

    it('should default totalCount to 0 when header missing', async () => {
      mockGet.mockResolvedValue({ status: 200, data: [], headers: {} });

      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      const result = await client.getPaginated('/items');

      expect(result.totalCount).toBe(0);
    });
  });

  describe('post', () => {
    it('should perform POST and return data', async () => {
      mockPost.mockResolvedValue({ status: 201, data: { id: 5 } });

      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      const result = await client.post('/items', { name: 'new' });

      expect(mockPost).toHaveBeenCalledWith('/items', { name: 'new' }, { params: undefined });
      expect(result).toEqual({ id: 5 });
    });
  });

  describe('put', () => {
    it('should perform PUT and return data', async () => {
      mockPut.mockResolvedValue({ status: 200, data: { updated: true } });

      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      const result = await client.put('/items/1', { name: 'updated' });

      expect(result).toEqual({ updated: true });
    });
  });

  describe('patch', () => {
    it('should perform PATCH and return data', async () => {
      mockPatch.mockResolvedValue({ status: 200, data: { patched: true } });

      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      const result = await client.patch('/items/1', { status: 'done' });

      expect(result).toEqual({ patched: true });
    });
  });

  describe('delete', () => {
    it('should perform DELETE and return data', async () => {
      mockDelete.mockResolvedValue({ status: 204, data: '' });

      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      const result = await client.delete('/items/1');

      expect(result).toBe('');
    });
  });

  describe('createHttpClient factory', () => {
    it('should return McpHttpClient instance', () => {
      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      expect(client).toBeInstanceOf(McpHttpClient);
    });
  });

  describe('security hardening', () => {
    it('creates the axios instance with maxRedirects:0 + size caps', async () => {
      const axios = (await import('axios')).default as any;
      createHttpClient({ baseURL: 'https://api.example.com' });
      const cfg = axios.create.mock.calls.at(-1)[0];
      expect(cfg.maxRedirects).toBe(0);
      expect(cfg.maxContentLength).toBeGreaterThan(0);
      expect(cfg.maxBodyLength).toBeGreaterThan(0);
    });

    it('normalizeError throws a sanitized Error WITHOUT the raw response (no auth-header/cookie leak)', async () => {
      const axiosErr: any = {
        isAxiosError: true,
        message: 'Request failed',
        config: { headers: { Authorization: 'Bearer SECRET' } },
        response: {
          status: 403, statusText: 'Forbidden', data: { message: 'denied' },
          headers: { 'set-cookie': 'sid=LEAKED' },
          config: { headers: { Authorization: 'Bearer SECRET' } },
        },
      };
      mockGet.mockRejectedValue(axiosErr);
      const client = createHttpClient({ baseURL: 'https://api.example.com' });

      let caught: any;
      try { await client.get('/x'); } catch (e) { caught = e; }
      expect(caught.message).toBe('denied');
      expect(caught.status).toBe(403);
      expect(caught.statusText).toBe('Forbidden');
      expect(caught.response).toBeUndefined();           // raw response NOT attached
      const ownProps = Object.getOwnPropertyNames(caught).map(k => JSON.stringify((caught as any)[k])).join('|');
      expect(ownProps).not.toContain('SECRET');           // no Authorization header rode along
      expect(ownProps).not.toContain('LEAKED');           // no set-cookie rode along
    });

    it('only retries 429/5xx for IDEMPOTENT methods (never POST/PATCH)', () => {
      mockIsNetworkOrIdempotent.mockReturnValue(false); // isolate the status-based branch
      createHttpClient({ baseURL: 'https://api.example.com' });
      const retryCondition = mockAxiosRetry.mock.calls.at(-1)[1].retryCondition;
      const err = (method: string, status: number) => ({ config: { method }, response: { status } });
      expect(retryCondition(err('get', 503))).toBe(true);
      expect(retryCondition(err('put', 429))).toBe(true);
      expect(retryCondition(err('delete', 502))).toBe(true);
      expect(retryCondition(err('post', 503))).toBe(false);   // non-idempotent — never replayed
      expect(retryCondition(err('patch', 429))).toBe(false);
    });

    it('retry condition follows isNetworkOrIdempotentRequestError when it returns true', () => {
      mockIsNetworkOrIdempotent.mockReturnValue(true); // network/idempotent errors are always retried
      createHttpClient({ baseURL: 'https://api.example.com' });
      const retryCondition = mockAxiosRetry.mock.calls.at(-1)[1].retryCondition;
      expect(retryCondition({ config: { method: 'post' }, response: { status: 200 } })).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Error paths — every verb routes failures through normalizeError, and the
  // normalizer's branches are all exercised.
  // -------------------------------------------------------------------------
  describe('error paths', () => {
    const axiosErr = (overrides: Record<string, unknown> = {}) => ({
      isAxiosError: true,
      message: 'Request failed',
      response: { status: 500, statusText: 'Server Error', data: {} },
      ...overrides,
    });

    it('getPaginated rejects → throws a normalized error', async () => {
      mockGet.mockRejectedValue(axiosErr());
      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      await expect(client.getPaginated('/x')).rejects.toThrow('HTTP 500 Server Error');
    });

    it('post rejects → throws a normalized error', async () => {
      mockPost.mockRejectedValue(axiosErr());
      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      await expect(client.post('/x', {})).rejects.toThrow('HTTP 500 Server Error');
    });

    it('put rejects → throws a normalized error', async () => {
      mockPut.mockRejectedValue(axiosErr());
      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      await expect(client.put('/x', {})).rejects.toThrow('HTTP 500 Server Error');
    });

    it('patch rejects → throws a normalized error', async () => {
      mockPatch.mockRejectedValue(axiosErr());
      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      await expect(client.patch('/x', {})).rejects.toThrow('HTTP 500 Server Error');
    });

    it('delete rejects → throws a normalized error', async () => {
      mockDelete.mockRejectedValue(axiosErr());
      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      await expect(client.delete('/x')).rejects.toThrow('HTTP 500 Server Error');
    });

    it('axios error with NO response → "HTTP undefined undefined"', async () => {
      mockGet.mockRejectedValue({ isAxiosError: true, message: 'Network Error' });
      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      await expect(client.get('/x')).rejects.toThrow('HTTP undefined undefined');
    });

    it('passes a non-axios Error through unchanged', async () => {
      const original = new Error('plain failure');
      mockGet.mockRejectedValue(original);
      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      await expect(client.get('/x')).rejects.toBe(original);
    });

    it('wraps a non-axios, non-Error value into an Error', async () => {
      mockGet.mockRejectedValue('string failure');
      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      await expect(client.get('/x')).rejects.toThrow('string failure');
    });

    it('getAxiosInstance returns the underlying instance', () => {
      const client = createHttpClient({ baseURL: 'https://api.example.com' });
      expect(client.getAxiosInstance()).toBe(mockInstance);
    });
  });
});
