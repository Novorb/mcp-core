/**
 * Child process for the env-proxy test of `guardedFetch`: run with NODE_USE_ENV_PROXY=1 and HTTP(S)_PROXY
 * pointing at a recording proxy. Fetches from a name whose (fake) DNS answer is 127.0.0.1 and prints the
 * outcome as one JSON line. TARGET_SCHEME (http|https) and TARGET_PORT pick the URL.
 */
import type { LookupFunction } from 'node:net';
import { guardedFetch } from '../../src/net.js';

const origin = `${process.env.TARGET_SCHEME ?? 'http'}://files.example.test:${process.env.TARGET_PORT ?? '9'}`;
const asked: string[] = [];
const lookup: LookupFunction = (hostname, options, callback) => {
  asked.push(hostname);
  if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};

guardedFetch(`${origin}/a.bin`, { lookup, timeoutMs: 5000 }).then(
  (res) => console.log(JSON.stringify({ ok: true, status: res.status, asked })),
  (error: Error) => console.log(JSON.stringify({ ok: false, message: error.message, asked })),
);
