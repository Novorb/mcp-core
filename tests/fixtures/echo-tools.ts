import * as z from 'zod/v4';
import { createMcpServer, type McpServer, TOOL_ANNOTATIONS } from '../../src/server.js';
import { type AnyToolDefinition, defineTool, registerTools, toolError, toolResult } from '../../src/tools.js';
import { createDataStore, type DataStore, type JsonCache } from '../../src/utils/dataStore.js';
import { type EnvSchema, loadEnv } from '../../src/utils/envLoader.js';

/** Tool names the fixture registers, in registration order. */
export const ECHO_TOOL_NAMES = [
  'echo',
  'echo_json',
  'boom',
  'upstream_status',
  'paid_lookup',
  'note_create',
  'note_list',
  'note_delete',
];

/** The fixture's own env schema (mcp-core's keys are merged in by loadEnv). */
export const ECHO_ENV: EnvSchema = [
  {
    key: 'ECHO_UPSTREAM_TOKEN',
    secret: true,
    description: 'Credential the upstream_status tool presents to its (pretend) downstream API',
  },
];

/** Process-wide state: created once by `setup` and shared by every connection / HTTP request. */
export interface EchoShared {
  /** Named notes, in `<DATA_PATH>/cache/notes.json` (or memory when DATA_STORAGE=false). */
  notes: JsonCache<Record<string, string>>;
  /** The upstream credential ('' when unset). */
  token(): string;
}

/** Build the shared state over a data store. */
export function createEchoShared(store: DataStore, token: () => string): EchoShared {
  return { notes: store.jsonCache<Record<string, string>>({ name: 'notes', ttlMs: Number.POSITIVE_INFINITY }), token };
}

const noteName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

async function readNotes(shared: EchoShared): Promise<Record<string, string>> {
  return (await shared.notes.read())?.data ?? {};
}

/**
 * The fixture tools, standing in for a real consumer server:
 * - `echo` (read) returns `echo: <text>` as text and writes one DEBUG line;
 * - `echo_json` (read) returns `{ text, length }` as structuredContent plus a JSON text block;
 * - `boom` (read) logs an ERROR and returns an isError result;
 * - `upstream_status` (read) checks ECHO_UPSTREAM_TOKEN like a downstream API would: a missing token or
 *   one starting `bad-` is an auth failure (isError);
 * - `paid_lookup` (costly) pretends to spend upstream quota;
 * - `note_create` (write), `note_list` (read), `note_delete` (destructive) keep named notes in the data
 *   store; deleting an unknown note is a not-found isError.
 */
export function echoTools(shared: EchoShared): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'echo',
      description: 'Echo the input text back',
      inputSchema: z.object({ text: z.string() }),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async ({ text }, ctx) => {
        ctx.logger.debug('echo handled', 'Tools');
        return toolResult(`echo: ${text}`);
      },
    }),
    defineTool({
      name: 'echo_json',
      description: 'Echo the input as structured content',
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ text: z.string(), length: z.number() }),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async ({ text }) => toolResult({ text, length: text.length }),
    }),
    defineTool({
      name: 'boom',
      description: 'Always fails with a tool-level error',
      inputSchema: z.object({}),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async (_args, ctx) => {
        ctx.logger.error('boom failed on purpose', 'Tools');
        return toolError('boom: failed');
      },
    }),
    defineTool({
      name: 'upstream_status',
      description: 'Report whether the upstream credential is accepted',
      inputSchema: z.object({}),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async (_args, ctx) => {
        const token = shared.token();
        if (token === '' || token.startsWith('bad-')) {
          ctx.logger.error('upstream rejected the credential (401)', 'Upstream');
          return toolError('upstream: 401 Unauthorized');
        }
        return toolResult({ authenticated: true });
      },
    }),
    defineTool({
      name: 'paid_lookup',
      description: 'A lookup that spends upstream quota',
      inputSchema: z.object({ query: z.string() }),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async ({ query }) => toolResult({ query, charged: 1 }),
    }),
    defineTool({
      name: 'note_create',
      description: 'Create or replace a named note',
      inputSchema: z.object({ name: noteName, body: z.string() }),
      annotations: TOOL_ANNOTATIONS.idempotentWrite,
      handler: async ({ name, body }) => {
        await shared.notes.write({ ...(await readNotes(shared)), [name]: body });
        return toolResult({ name, created: true });
      },
    }),
    defineTool({
      name: 'note_list',
      description: 'List note names, optionally by prefix',
      inputSchema: z.object({ prefix: z.string().optional() }),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async ({ prefix }) => {
        const names = Object.keys(await readNotes(shared)).sort();
        return toolResult({ names: names.filter((n) => !prefix || n.startsWith(prefix)) });
      },
    }),
    defineTool({
      name: 'note_delete',
      description: 'Delete a named note',
      inputSchema: z.object({ name: noteName }),
      annotations: TOOL_ANNOTATIONS.destructive,
      handler: async ({ name }) => {
        const notes = await readNotes(shared);
        if (!(name in notes)) return toolError(`note not found: ${name}`);
        delete notes[name];
        await shared.notes.write(notes);
        return toolResult({ name, deleted: true });
      },
    }),
  ];
}

// In-process default (unit tests, in-memory harness): stateless storage, so notes live in memory for
// the process lifetime, and the credential is read live from process.env.
const inProcessEnv = loadEnv(ECHO_ENV, {
  rootDir: process.cwd(),
  env: { MCP_ENV_FILE: 'none', DATA_STORAGE: 'false' },
});
const inProcessShared = createEchoShared(
  createDataStore({ rootDir: process.cwd(), env: inProcessEnv }),
  () => process.env.ECHO_UPSTREAM_TOKEN ?? '',
);

/** Register the fixture tools on `server` (the shape a consumer's `registerTools(server)` has). */
export function registerEchoTools(server: McpServer, shared: EchoShared = inProcessShared): void {
  registerTools(server, echoTools(shared), { serverName: 'echo-fixture' });
}

/** A zero-argument server factory over the in-process shared state. */
export function buildEchoServer(): McpServer {
  const server = createMcpServer('echo-fixture', '1.0.0');
  registerEchoTools(server);
  return server;
}
