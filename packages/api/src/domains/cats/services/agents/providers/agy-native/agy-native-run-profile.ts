import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { canonicalWin32Path, hardenWin32PrivateDirectoryAcl } from '../../../../../../config/win32-fs-security.js';
import { prepareAgyAccountDataView } from './run/agy-account-data-view.js';

const DISPOSE_RM_OPTIONS =
  process.platform === 'win32'
    ? ({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const)
    : ({ recursive: true, force: true } as const);

export const AGY_NATIVE_RUNS = '.cat-cafe-native-runs';

function directory(path: string, hardenWin32 = false): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Native run directory must not redirect: ${path}`);
    }
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (hardenWin32) {
    hardenWin32PrivateDirectoryAcl(path);
  }
}

/**
 * --gemini_dir owns configuration; --app_data_dir selects canonical account data.
 * Keep one normalized data pathname and a stable logical app identity across
 * disposable config roots. Launch also fences native database initialization.
 */
export function createAgyNativeRunProfile(
  profileHome: string,
  credentialHome?: string,
): {
  readonly home: string;
  readonly geminiDir: string;
  readonly appDataDir: string;
  dispose(): void;
} {
  const account = canonicalWin32Path(profileHome);
  const runs = join(account, AGY_NATIVE_RUNS);
  const data = join(account, '.gemini', 'antigravity-cli');
  const projects = join(account, '.gemini', 'config', 'projects');
  directory(runs, true);
  directory(data);
  directory(join(account, '.gemini', 'config'), true);
  directory(projects);
  const home = mkdtempSync(join(runs, 'run-'));
  const geminiDir = join(home, '.gemini');
  try {
    hardenWin32PrivateDirectoryAcl(home);
    directory(geminiDir, true);
    directory(join(geminiDir, 'config'), true);
    symlinkSync(projects, join(geminiDir, 'config', 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return {
    home,
    geminiDir,
    appDataDir: relative(geminiDir, credentialHome ? prepareAgyAccountDataView(account, credentialHome) : data),
    dispose: () => rmSync(home, DISPOSE_RM_OPTIONS),
  };
}
