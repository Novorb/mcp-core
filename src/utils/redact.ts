/**
 * @novorb/mcp-core - secret redaction and PII masking for log entries.
 *
 * Applied by the logger to every entry: the message, the context and every value in `meta`.
 * - Sensitive-keyed fields in objects become `[REDACTED]` (keys are matched by name segment).
 * - Secrets inside strings: secret query/form parameters become `name=[REDACTED]`, connection-string
 *   passwords `scheme://user:[REDACTED]@host`, HTTP Basic credentials `Basic [TOKEN]`.
 * - PII inside strings and object keys becomes a typed placeholder:
 *   [EMAIL] [PHONE] [CARD] [IBAN] [JWT] [TOKEN] [IP].
 * - Strings over MAX_STRING_CHARS are truncated with a marker; subtrees deeper than MAX_DEPTH become
 *   `[DEPTH]`, cycles `[CIRCULAR]`; arrays and objects keep their first MAX_ITEMS entries.
 *
 * Every pattern is linear-time: each one either starts only at a run boundary (a lookbehind that
 * rejects a start inside a run of its own characters) or has bounded quantifiers, so no input can make
 * a log call backtrack quadratically.
 */

const REDACTED = '[REDACTED]';
/** Strings longer than this are truncated (with a marker) before they are masked and written. */
export const MAX_STRING_CHARS = 32768;
/** Nesting levels kept in meta; anything deeper becomes `[DEPTH]`. */
export const MAX_DEPTH = 8;
/** Array items / object keys kept per level; the rest are summarised. */
export const MAX_ITEMS = 200;
// How far back from the cut a truncation looks for a delimiter, so no partial token is left behind.
const TRUNCATE_LOOKBACK = 4096;

// ---------------------------------------------------------------------------------------------------
// Sensitive keys, matched by name segment (camelCase, snake_case, kebab-case, dotted).
// ---------------------------------------------------------------------------------------------------

// A segment (or two or three adjacent segments joined) that names a secret.
const SECRET_NOUNS = new Set([
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'token',
  'cookie',
  'cookies',
  'authorization',
  'bearer',
  'signature',
  'sig',
  'credential',
  'credentials',
  'tempauth',
  'apikey',
  'accesskey',
  'privatekey',
  'secretkey',
  'signingkey',
  'encryptionkey',
  'clientsecret',
  'xapikey',
]);
// Segments that may follow a secret noun and still hold the secret (`passwordHash`, `tokenValue`).
const SECRET_SUFFIXES = new Set([
  'value',
  'hash',
  'raw',
  'plain',
  'plaintext',
  'b64',
  'base64',
  'hex',
  'enc',
  'encrypted',
  'str',
  'string',
  'data',
]);

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/**
 * A key is sensitive when it is exactly `key`, or when a secret noun (one segment, or 2-3 adjacent
 * segments joined, e.g. `api`+`key`) is followed only by secret-bearing suffixes. So `accessToken`,
 * `X-Amz-Signature`, `passwordHash` are sensitive and `maxTokens`, `tokenExpiry`, `signatureAlgorithm`,
 * `credentialType`, `primaryKey` are not.
 */
export function isSensitiveKey(key: string): boolean {
  if (key.toLowerCase() === 'key') return true;
  const segs = keySegments(key);
  for (let end = segs.length - 1; end >= 0; end--) {
    for (let len = 1; len <= 3 && end - len + 1 >= 0; len++) {
      const noun = segs.slice(end - len + 1, end + 1).join('');
      if (SECRET_NOUNS.has(noun) && segs.slice(end + 1).every((s) => SECRET_SUFFIXES.has(s))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// Secrets inside strings
// ---------------------------------------------------------------------------------------------------

const SECRET_PARAM_NAMES =
  'key|api_key|apikey|access_key|token|access_token|refresh_token|id_token|signature|sig|password|secret|tempauth|client_secret|x-amz-signature|x-amz-credential|x-amz-security-token';
// A parameter at the start of the string, after ?, &, ; or whitespace. The value is bounded.
const SENSITIVE_QUERY_PARAM = new RegExp(`((?:^|[?&;\\s])(?:${SECRET_PARAM_NAMES})=)[^&;#\\s"']{0,4096}`, 'gi');
// scheme://user:password@ ; every part bounded, starting at a word boundary.
const USERINFO = /\b([a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@]{1,256}:)[^\s/@]{1,256}@/gi;
const BASIC = /\b(basic)[ \t]{1,8}([A-Za-z0-9+/]{8,4096}={0,2})(?![A-Za-z0-9+/=])/gi;

/** Replace the values of secret query / form parameters in a string with `[REDACTED]`. */
export function redactQueryParams(s: string): string {
  return s.replace(SENSITIVE_QUERY_PARAM, `$1${REDACTED}`);
}

function looksLikeBasicCredentials(b64: string): boolean {
  if (b64.length % 4 !== 0) return false;
  return Buffer.from(b64, 'base64').toString('latin1').includes(':');
}

/** Secret parameters, connection-string passwords and HTTP Basic credentials in a string. */
export function redactStringSecrets(s: string): string {
  return redactQueryParams(s)
    .replace(USERINFO, `$1${REDACTED}@`)
    .replace(BASIC, (match, word: string, b64: string) => (looksLikeBasicCredentials(b64) ? `${word} [TOKEN]` : match));
}

// ---------------------------------------------------------------------------------------------------
// PII
// ---------------------------------------------------------------------------------------------------

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/ /g, '');
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : ch;
    for (const d of value) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

// Card issuer prefixes (Visa, Mastercard incl. 2-series, Amex, Diners, JCB, Discover, UnionPay).
const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[0478]|35|6)/;

const BEARER = /\b(bearer)[ \t]{1,8}([A-Za-z0-9\-._~+/]{1,4096}={0,4})/gi;
const JWT = /(?<![\w-])eyJ[A-Za-z0-9_-]{2,16384}\.[A-Za-z0-9_-]{2,16384}\.[A-Za-z0-9_-]{0,16384}/g;
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const CARD = /(?<![\d-])[2-6]\d(?:[ -]?\d){11,17}(?![\d-])/g;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const IPV4 = new RegExp(`(?<![\\d.vV])(?:${OCTET}\\.){3}${OCTET}(?![\\d.])`, 'g');
const H = '[0-9a-fA-F]{1,4}';
const IPV6_BODY = `(?:(?:${H}:){7}${H}|(?:${H}:){1,7}:|(?:${H}:){1,6}:${H}|(?:${H}:){1,5}(?::${H}){1,2}|(?:${H}:){1,4}(?::${H}){1,3}|(?:${H}:){1,3}(?::${H}){1,4}|(?:${H}:){1,2}(?::${H}){1,5}|${H}:(?::${H}){1,6}|:(?::${H}){1,7})`;
// A bracketed IPv6 (`[::1]` in a URL or a bind address) is replaced together with its brackets.
const IPV6 = new RegExp(`\\[${IPV6_BODY}\\]|(?<![\\w:])${IPV6_BODY}(?![\\w:])`, 'g');
// International: a country code 1-9, then digit groups separated by space or dash (never '.', so signed
// decimals like +0.00012345 stay). Compact forms need 10+ digits so a signed integer stays.
const PHONE_INTL = /(?<![\w+.])\+[1-9]\d{0,2}(?:[ -]?\(?\d{1,4}\)?){2,5}(?![\w.])/g;
const PHONE_NANP = /(?<![\w.])(?:\(\d{3}\) ?|\d{3}[.-])\d{3}[.-]\d{4}(?![\w.])/g;
// National (leading 0): area + subscriber (06-12345678, 030 12345678) or area + two space groups
// (020 123 4567). A three-group dashed number is a reference, not a phone.
const PHONE_NATIONAL = /(?<![\w.:/-])0\d{1,4}(?:[ -]\d{6,8}| \d{2,4} \d{2,4})(?![\w.-])/g;

function maskBearer(match: string, word: string, token: string): string {
  // Prose such as "Bearer authentication" is a short all-lowercase word; any token with a digit,
  // symbol or capital letter, or 16+ characters, is treated as a credential.
  const prose = /^[a-z]{1,15}$/.test(token);
  return prose ? match : `${word} [TOKEN]`;
}

/** Mask PII in a string with typed placeholders. Linear-time on any input. */
export function maskPii(s: string): string {
  return s
    .replace(BEARER, maskBearer)
    .replace(JWT, '[JWT]')
    .replace(EMAIL, '[EMAIL]')
    .replace(IBAN, (match) => (ibanValid(match) ? '[IBAN]' : match))
    .replace(CARD, (match) => {
      const d = digitsOf(match);
      return d.length >= 13 && d.length <= 19 && CARD_PREFIX.test(d) && luhnValid(d) ? '[CARD]' : match;
    })
    .replace(IPV4, '[IP]')
    .replace(IPV6, '[IP]')
    .replace(PHONE_INTL, (match) => {
      const n = digitsOf(match).length;
      const separated = /[ (-]/.test(match);
      return n >= 8 && n <= 15 && (separated || n >= 10) ? '[PHONE]' : match;
    })
    .replace(PHONE_NANP, '[PHONE]')
    .replace(PHONE_NATIONAL, (match) => {
      const n = digitsOf(match).length;
      return n >= 9 && n <= 11 ? '[PHONE]' : match;
    });
}

/**
 * Cut a string to MAX_STRING_CHARS with a `...[TRUNCATED <n> chars]` marker. The cut moves back to the
 * last delimiter within TRUNCATE_LOOKBACK chars (or drops that whole window), so a secret straddling
 * the cut is never left half-visible where its pattern no longer matches.
 */
export function truncateString(s: string): string {
  if (s.length <= MAX_STRING_CHARS) return s;
  let cut = MAX_STRING_CHARS;
  const floor = MAX_STRING_CHARS - TRUNCATE_LOOKBACK;
  while (cut > floor && !/[\s"'&;,<>()[\]{}|]/.test(s[cut - 1])) cut--;
  return `${s.slice(0, cut)}...[TRUNCATED ${s.length - cut} chars]`;
}

/** Truncation, secret redaction and PII masking, for one string. */
export function sanitizeString(s: string): string {
  return maskPii(redactStringSecrets(truncateString(s)));
}

// ---------------------------------------------------------------------------------------------------
// Structured values
// ---------------------------------------------------------------------------------------------------

function maskNumber(n: number): number | string {
  if (!Number.isInteger(n) || Math.abs(n) < 1e12) return n;
  const s = String(n);
  const masked = maskPii(s);
  return masked === s ? n : masked;
}

function redactEntries(
  entries: Array<[string, unknown]>,
  depth: number,
  seen: WeakSet<object>,
  total: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries.slice(0, MAX_ITEMS)) {
    let key = maskPii(truncateString(k));
    if (key in out) {
      let i = 2;
      while (`${key}#${i}` in out) i++;
      key = `${key}#${i}`;
    }
    out[key] = isSensitiveKey(k) ? REDACTED : redactValue(v, depth + 1, seen);
  }
  if (total > MAX_ITEMS) out['[truncated]'] = `[+${total - MAX_ITEMS} more keys]`;
  return out;
}

function redactError(err: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const own = Object.entries(err);
  const out: Record<string, unknown> = {
    name: sanitizeString(err.name),
    message: sanitizeString(err.message),
    ...redactEntries(own, depth, seen, own.length),
  };
  if (err.stack) out.stack = sanitizeString(err.stack);
  if (err.cause !== undefined) out.cause = redactValue(err.cause, depth + 1, seen);
  return out;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number') return maskNumber(value);
  if (typeof value === 'bigint') return sanitizeString(value.toString());
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    if (value instanceof URL) return sanitizeString(value.href);
    if (value instanceof ArrayBuffer) return `[Binary ${value.byteLength} bytes]`;
    if (ArrayBuffer.isView(value)) return `[Binary ${value.byteLength} bytes]`;
    if (value instanceof Error) return redactError(value, depth, seen);
    if (value instanceof Map) {
      const entries = [...value.entries()].map(([k, v]): [string, unknown] => [String(k), v]);
      return redactEntries(entries, depth, seen, value.size);
    }
    if (Array.isArray(value) || value instanceof Set) {
      const items = Array.isArray(value) ? value : [...value];
      const out: unknown[] = items.slice(0, MAX_ITEMS).map((v) => redactValue(v, depth + 1, seen));
      if (items.length > MAX_ITEMS) out.push(`[+${items.length - MAX_ITEMS} more]`);
      return out;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    return redactEntries(entries, depth, seen, entries.length);
  } catch {
    return '[UNREADABLE]';
  } finally {
    seen.delete(value);
  }
}

/**
 * Copy a value for logging: sensitive-keyed fields become `[REDACTED]`, every string and key is
 * sanitised, deep subtrees become `[DEPTH]`, cycles `[CIRCULAR]`, BigInt a string, Error/Date/URL/
 * Map/Set/binary a meaningful plain form. The result is always JSON-serialisable.
 */
export function redactSecrets(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}
