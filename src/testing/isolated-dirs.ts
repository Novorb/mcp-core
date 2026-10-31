/**
 * @novorb/mcp-core/testing - per-run temp directories so a server under test writes nothing into the
 * developer's tree or profile.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface IsolatedDirs {
  /** The temp root holding every other directory. */
  root: string;
  /** Working directory for the child (`cwd`). */
  cwd: string;
  /** Home directory (HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_* point inside it). */
  home: string;
  /** Log directory (LOG_PATH). */
  logs: string;
  /** State directory for the server's cache or state files (pass it under the server's own variable). */
  state: string;
  /** Temp directory (TMPDIR, TEMP, TMP). */
  tmp: string;
  /** Create (if needed) and return `<root>/<name>`, for extra data/db directories. */
  dir(name: string): string;
  /** HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_*, TMPDIR/TEMP/TMP and LOG_PATH for the child env. */
  env(): Record<string, string>;
  /** Remove the whole root (retries on Windows EBUSY/EPERM). Idempotent; never throws. */
  cleanup(): void;
}

function safeSegment(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  if (!safe) throw new Error(`createIsolatedDirs: invalid directory name "${name}"`);
  return safe;
}

/** Create a fresh temp root under the OS temp dir with cwd, home, logs, state and tmp inside it. */
export function createIsolatedDirs(prefix = 'mcp-it'): IsolatedDirs {
  const root = mkdtempSync(join(tmpdir(), `${safeSegment(prefix)}-`));
  const make = (name: string): string => {
    const path = join(root, safeSegment(name));
    mkdirSync(path, { recursive: true });
    return path;
  };
  const cwd = make('cwd');
  const home = make('home');
  const logs = make('logs');
  const state = make('state');
  const tmp = make('tmp');
  const appData = join(home, 'AppData', 'Roaming');
  const localAppData = join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  let removed = false;

  return {
    root,
    cwd,
    home,
    logs,
    state,
    tmp,
    dir: make,
    env: () => ({
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      LOG_PATH: logs,
    }),
    cleanup: () => {
      if (removed) return;
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        removed = true;
      } catch {
        // A file still held open (Windows) must not fail the suite; the OS temp dir is reaped later.
      }
    },
  };
}
