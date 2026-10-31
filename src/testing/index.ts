/**
 * @novorb/mcp-core/testing - test harness for MCP servers built on mcp-core.
 *
 * A SEPARATE subpath: no runtime entry point imports it. It needs `@modelcontextprotocol/client`
 * (an optional peer dependency; every consumer has it as a devDependency). Test-runner agnostic:
 * helpers return objects and throw Errors; nothing imports jest or vitest.
 *
 *   import { startBuiltServer, createIsolatedDirs, callToolJson } from '@novorb/mcp-core/testing';
 */

export { createTestClient, type ProtocolEra, type TestClientOptions } from './client.js';
export { type ConnectInMemoryOptions, connectInMemory, type InMemoryConnection } from './in-memory.js';
export { createIsolatedDirs, type IsolatedDirs } from './isolated-dirs.js';
export {
  collectStrings,
  findLeaks,
  type Leak,
  type LogFiles,
  logFileName,
  logLevels,
  MIN_LEAK_NEEDLE_LENGTH,
  maskValue,
  readLogFiles,
} from './logs.js';
export {
  initializeRequestBody,
  mcpPostHeaders,
  type RawHttpOptions,
  type RawHttpResponse,
  rawHttp,
} from './raw-http.js';
export {
  MODERN_PROTOCOL_VERSION,
  modernMeta,
  parseRpcBody,
  type RawPeer,
  type RawResponse,
  rawHttpPeer,
  rawPeer,
} from './raw-peer.js';
export {
  type CapturedPrompt,
  type CapturedTool,
  makeRecordingServer,
  type RecordedConfig,
  type RecordedPromptHandler,
  type RecordedToolHandler,
  type RecordingServer,
  type RecordingServerOptions,
} from './recording-server.js';
export {
  type BuiltServer,
  freePort,
  type HarnessMode,
  killAndWait,
  minimalOsEnv,
  type StartBuiltServerOptions,
  startBuiltServer,
} from './server-process.js';
export {
  assertToolCoverage,
  callToolJson,
  captureToolWire,
  listToolNames,
  type ToolCoverage,
  type ToolJsonResult,
  type ToolWire,
  toolCoverage,
} from './tools.js';
export {
  callToolInMemory,
  captureToolCall,
  expectSchemaRejection,
  expectToolError,
  expectToolSuccess,
  expectUnknownTool,
  INVALID_PARAMS_CODE,
  type Rejection,
  type ToolOutcome,
  withInMemoryClient,
} from './unit.js';
