/**
 * @novorb/mcp-core - The credential status tool
 *
 * `credentialStatusTool()` is a ready tool definition a server may register (with `registerTools`)
 * to list every credential's current status: key names, pools, statuses, reasons and retry-after
 * only, never a value. Integration tests read the startup check results through it.
 *
 *   registerTools(server, [...buildTools(shared), credentialStatusTool()], { env, serverName });
 */

import { type CredentialRegistry, processCredentials } from './credentials.js';
import { fromJsonSchema, TOOL_ANNOTATIONS } from './server.js';
import { type AnyToolDefinition, defineTool, toolResult } from './tools.js';

export interface CredentialStatusToolOptions {
  /** Tool name (default `credential_status`). */
  name?: string;
  /** The registry to list (default the process registry). */
  registry?: CredentialRegistry;
}

/** A read-only tool listing every credential's status (names and statuses only). */
export function credentialStatusTool(options: CredentialStatusToolOptions = {}): AnyToolDefinition {
  return defineTool({
    name: options.name ?? 'credential_status',
    title: 'Credential status',
    description:
      'List the status of every credential this server holds (valid, invalid, expired, degraded or unknown), by key name only.',
    inputSchema: fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
    annotations: TOOL_ANNOTATIONS.readOnly,
    handler: async () => {
      const credentials = (options.registry ?? processCredentials()).snapshot();
      const lines = credentials.map((c) => {
        const details = [c.reason, c.retryInSeconds !== undefined ? `retry in ${c.retryInSeconds}s` : undefined]
          .filter((d): d is string => d !== undefined)
          .join(', ');
        return `${c.key}${c.pool !== undefined && c.pool !== c.key ? ` [${c.pool}]` : ''}: ${c.status}${details ? ` (${details})` : ''}`;
      });
      return toolResult(
        { credentials },
        { text: credentials.length === 0 ? 'No credentials are registered.' : lines.join('\n') },
      );
    },
  });
}
