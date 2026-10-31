/**
 * @novorb/mcp-core - Credential health (subpath `./credentials`)
 *
 * The one import for credential health: the registry and the per-call scope (`credentials.ts`), the
 * startup checks (`credential-checks.ts`), the result report (`credential-report.ts`) and the status
 * tool (`credential-status-tool.ts`). Pure re-exports.
 */

export {
  type CredentialCheck,
  type CredentialCheckContext,
  type CredentialCheckResult,
  DEFAULT_CREDENTIAL_CHECK_CONCURRENCY,
  DEFAULT_CREDENTIAL_CHECK_TIMEOUT_MS,
  type RunCredentialChecksOptions,
  registerEnvCredentials,
  runCredentialChecks,
} from './credential-checks.js';
export {
  attachCredentialMeta,
  attachCredentialReport,
  CREDENTIALS_FIELD,
  CREDENTIALS_JSON_SCHEMA,
  CREDENTIALS_META_KEY,
  credentialReportBytes,
  withCredentialsField,
} from './credential-report.js';
export { type CredentialStatusToolOptions, credentialStatusTool } from './credential-status-tool.js';
export {
  type AuthChallenge,
  type ClassifiedOutcome,
  CREDENTIAL_STATUSES,
  type CredentialHttpFacts,
  type CredentialOutcome,
  type CredentialOutcomeInfo,
  type CredentialProbe,
  type CredentialRecorder,
  CredentialRegistry,
  type CredentialRegistryOptions,
  type CredentialReportEntry,
  CredentialScope,
  type CredentialState,
  type CredentialStatus,
  credentialOutcomeFromError,
  credentialOutcomeFromHttp,
  currentCredentialScope,
  DEFAULT_CREDENTIAL_RECHECK_MS,
  formatCredentialReport,
  NoUsableCredentialError,
  parseAuthChallenge,
  processCredentials,
  runWithCredentialScope,
  setProcessCredentials,
  UnknownCredentialError,
} from './credentials.js';
