import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

export const AGY_NATIVE_RUNS = '.cat-cafe-native-runs';

function directory(path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error(`Native run directory must not redirect: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * --gemini_dir owns configuration; --app_data_dir selects canonical account data.
 * Keep one normalized data pathname and a stable logical app identity across
 * disposable config roots. Launch also fences native database initialization.
 */
export function createAgyNativeRunProfile(profileHome: string): {
  readonly home: string;
  readonly geminiDir: string;
  readonly appDataDir: string;
  dispose(): void;
} {
  const account = realpathSync(profileHome);
  const runs = join(account, AGY_NATIVE_RUNS);
  const data = join(account, '.gemini', 'antigravity-cli');
  const projects = join(account, '.gemini', 'config', 'projects');
  directory(runs);
  directory(data);
  directory(join(account, '.gemini', 'config'));
  directory(projects);
  const home = mkdtempSync(join(runs, 'run-'));
  const geminiDir = join(home, '.gemini');
  try {
    directory(geminiDir);
    directory(join(geminiDir, 'config'));
    symlinkSync(projects, join(geminiDir, 'config', 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return {
    home,
    geminiDir,
    appDataDir: relative(geminiDir, data),
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}
