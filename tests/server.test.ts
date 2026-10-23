import { describe, expect, it } from '@jest/globals';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import * as barrel from '../src/index.js';
import {
  completable,
  createMcpServer,
  fromJsonSchema,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  TOOL_ANNOTATIONS,
} from '../src/server.js';

describe('server module', () => {
  describe('createMcpServer', () => {
    it('returns an McpServer instance', () => {
      const server = createMcpServer('test-mcp', '1.2.3');
      expect(server).toBeInstanceOf(McpServer);
      expect(typeof server.registerTool).toBe('function');
      expect(typeof server.registerPrompt).toBe('function');
    });

    it('creates an independent instance per call', () => {
      const a = createMcpServer('a', '1.0.0');
      const b = createMcpServer('b', '1.0.0');
      expect(a).not.toBe(b);
    });

    it('wraps a low-level Server reachable as .server', () => {
      const server = createMcpServer('low', '1.0.0');
      expect(server.server).toBeInstanceOf(Server);
    });
  });

  describe('TOOL_ANNOTATIONS presets', () => {
    it('readOnly is read-only + idempotent', () => {
      expect(TOOL_ANNOTATIONS.readOnly).toEqual({ readOnlyHint: true, idempotentHint: true });
    });

    it('idempotentWrite is a non-read, idempotent write', () => {
      expect(TOOL_ANNOTATIONS.idempotentWrite).toEqual({ readOnlyHint: false, idempotentHint: true });
    });

    it('mutableWrite is a non-idempotent write', () => {
      expect(TOOL_ANNOTATIONS.mutableWrite).toEqual({ readOnlyHint: false, idempotentHint: false });
    });

    it('destructive carries the destructive hint', () => {
      expect(TOOL_ANNOTATIONS.destructive).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
    });

    it('each *OpenWorld variant is its base preset plus openWorldHint: true', () => {
      for (const base of ['readOnly', 'idempotentWrite', 'mutableWrite', 'destructive'] as const) {
        expect(TOOL_ANNOTATIONS[`${base}OpenWorld`]).toEqual({ ...TOOL_ANNOTATIONS[base], openWorldHint: true });
      }
      expect(Object.keys(TOOL_ANNOTATIONS)).toHaveLength(8);
    });
  });

  describe('re-exports', () => {
    it('completable is a function (SDK re-export)', () => {
      expect(typeof completable).toBe('function');
    });

    it('Server is the low-level SDK server class', () => {
      const low = new Server({ name: 'low', version: '1.0.0' }, { capabilities: { tools: {} } });
      expect(typeof low.setRequestHandler).toBe('function');
    });

    it('fromJsonSchema wraps a raw JSON Schema into a usable tool input schema', () => {
      const schema = fromJsonSchema({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
      const server = createMcpServer('json-schema', '1.0.0');
      expect(() => server.registerTool('lookup', { inputSchema: schema }, async () => ({ content: [] }))).not.toThrow();
    });

    it('ProtocolError carries a ProtocolErrorCode', () => {
      const err = new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad input');
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(-32602);
      expect(ProtocolErrorCode.MethodNotFound).toBe(-32601);
    });
  });

  describe('barrel (src/index.ts)', () => {
    it('exports exactly the documented runtime surface', () => {
      expect(Object.keys(barrel).sort()).toEqual(
        [
          'McpHttpClient',
          'createHttpClient',
          'HttpError',
          'TokenBucket',
          'createTokenBucket',
          'buildQueryString',
          'joinUrl',
          'templatePath',
          'CURSOR_VERSION',
          'DEFAULT_MAX_PAGES',
          'HARD_MAX_PAGES',
          'MAX_CURSOR_LENGTH',
          'InvalidCursorError',
          'continuationToken',
          'decodeCursor',
          'defaultItems',
          'encodeCursor',
          'invalidCursorResult',
          'linkHeader',
          'nextLinkField',
          'nextPageHeader',
          'offsetLimit',
          'pagedResultSchema',
          'pagePerPage',
          'paginateArrayByCursor',
          'paginateRequests',
          'parseLinkHeader',
          'readHeaderTotal',
          'IDEMPOTENT_METHODS',
          'RETRYABLE_NETWORK_CODES',
          'RETRYABLE_STATUS_CODES',
          'errorStatus',
          'isIdempotentMethod',
          'isRetryableStatus',
          'retryAfterFromError',
          'retryDelayFor',
          'throwIfAborted',
          'Logger',
          'LogLevel',
          'getLogger',
          'initLogger',
          'resetLogger',
          'logToolCall',
          'logToolResult',
          'summarizeArgs',
          'packageRootFrom',
          'createPaginationMetadata',
          'normalizePagination',
          'pageToOffset',
          'paginateArray',
          'calculateRetryDelay',
          'isRetryableError',
          'parseRetryAfter',
          'retryWithBackoff',
          'sleep',
          'McpServer',
          'Server',
          'TOOL_ANNOTATIONS',
          'completable',
          'createMcpServer',
          'fromJsonSchema',
          'ProtocolError',
          'ProtocolErrorCode',
          'startMcpServer',
          'registerSecretValues',
          'readPackageInfo',
          'runMcpServer',
          'defaultMapError',
          'defineTool',
          'normalizeOutcome',
          'notConfiguredMessage',
          'registerTools',
          'toolError',
          'toolResult',
          'CORE_ENV_SCHEMA',
          'loadEnv',
          'renderEnvExample',
          'renderEnvTable',
          'createDataStore',
          'DataPathError',
          'DataStorageDisabledError',
          'DownloadError',
          'resolveInside',
          'safeName',
          // auth
          'API_KEY_TOKEN_PLACEHOLDER',
          'API_KEY_TTL_SECONDS',
          'apiKeyVerifier',
          // bootstrap / transport
          'transportFromEnv',
          'DEFAULT_MAX_BODY_BYTES',
          'resolveTransportMode',
          // client input
          'requestEra',
          'supportsClientFeature',
          // limits and list pagination
          'DEFAULT_LIST_PAGE_SIZE',
          'DEFAULT_MAX_RESULT_BYTES',
          'DEFAULT_MAX_RESULT_ITEMS',
          'DEFAULT_MAX_TOOL_INPUT_ELEMENTS',
          'HARD_MAX_COLLECT_ITEMS',
          'resolveLimits',
          'LIST_RESULT_KEYS',
          'pageListResult',
          'paginateLists',
          // protocol logging
          'addLogListener',
          'currentRequestContext',
          'enableProtocolLogging',
          'protocolLoggingEnabled',
          'runWithRequestContext',
          'toMcpLoggingLevel',
          // server re-exports and defaults
          'DEFAULT_CACHE_HINTS',
          'inputRequired',
          'OAuthError',
          'OAuthErrorCode',
          'requireScopes',
          'UrlElicitationRequiredError',
          // tools
          'maskClientText',
          // express adapter availability
          'EXPRESS_PEERS_MISSING',
          'ExpressAdapterUnavailableError',
          // server re-exports for prompts, resources and requestState
          'acceptedContent',
          'createRequestStateCodec',
          'inputResponse',
          'ResourceNotFoundError',
          'ResourceTemplate',
          'requestStateCodecOf',
          // notifications and the runtime surface
          'attachNotifications',
          'bindToSurface',
          'createNotifier',
          'createRuntimeSurface',
          'InMemoryServerEventBus',
          'processBus',
          'resourceSubscriptions',
          'setProcessBus',
          // prompts and protocol errors
          'definePrompt',
          'normalizePromptOutcome',
          'registerPrompts',
          'toProtocolError',
          // requestState
          'createSealedRequestStateCodec',
          'DEFAULT_REQUEST_STATE_TTL_SECONDS',
          'defaultRequestStateBinding',
          'MIN_REQUEST_STATE_KEY_BYTES',
          'RequestStateError',
          'RequestStateKeyError',
          'requestStateCodecFromEnv',
          // resources
          'blobContents',
          'createResultSpill',
          'defineResource',
          'defineResourceTemplate',
          'embeddedResource',
          'enableResourceSubscriptions',
          'normalizeReadOutcome',
          'registerResources',
          'resourceLink',
          'textContents',
          // tasks
          'createTaskStore',
          'FileTaskStore',
          'InMemoryTaskStore',
          'isTerminalStatus',
          'TASK_STATUSES',
          'TASKS_EXTENSION_ID',
          'declaresTasksExtension',
          'defineTaskTool',
          'enableTasks',
          'registerTaskTools',
          'toLegacyTask',
        ].sort(),
      );
    });
  });

  describe('completable nesting (SDK v2 rule)', () => {
    async function completeArg(argument: string, value: string): Promise<string[]> {
      const suggest = (val: string | undefined): string[] => ['foo', 'bar'].filter((k) => k.startsWith(val ?? ''));
      const server = createMcpServer('completion', '1.0.0');
      server.registerPrompt(
        'find',
        {
          argsSchema: z.object({
            required: completable(z.string(), suggest),
            outerOptional: completable(z.string(), suggest).optional(),
            innerOptional: completable(z.string().optional(), suggest),
          }),
        },
        () => ({ messages: [] }),
      );
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'completion-test', version: '1.0.0' });
      await server.connect(serverSide);
      await client.connect(clientSide);
      try {
        const result = await client.complete({
          ref: { type: 'ref/prompt', name: 'find' },
          argument: { name: argument, value },
        });
        return result.completion.values;
      } finally {
        await client.close();
        await server.close();
      }
    }

    it('completes a required completable argument', async () => {
      await expect(completeArg('required', 'f')).resolves.toEqual(['foo']);
    });

    it('completes completable(z.string(), cb).optional() (optional on the outside)', async () => {
      await expect(completeArg('outerOptional', 'b')).resolves.toEqual(['bar']);
    });

    it('returns NO completions for completable(z.string().optional(), cb) (the v1 nesting)', async () => {
      await expect(completeArg('innerOptional', 'f')).resolves.toEqual([]);
    });
  });
});
