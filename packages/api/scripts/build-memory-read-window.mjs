import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const defaultOutput = path.join(root, 'dist/native/sqlite-read-window.dylib');

/** Release-time compilation, following the existing app-assist native build.
 * No compiler, downloaded dependency or code generation runs in the reader. */
export function buildMemoryReadWindow({ output = defaultOutput, test = false } = {}) {
  rmSync(output, { force: true });
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) return false;
  const headers = path.join(path.dirname(require.resolve('better-sqlite3/package.json')), 'deps/sqlite3');
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    execFileSync(
      'xcrun',
      [
        'clang',
        '-arch',
        process.arch === 'x64' ? 'x86_64' : 'arm64',
        '-O2',
        '-dynamiclib',
        '-Wl,-install_name,@rpath/sqlite-read-window.dylib',
        '-fvisibility=hidden',
        '-Wall',
        '-Wextra',
        ...(test ? ['-DMEMORY_READ_WINDOW_TEST=1'] : []),
        '-I',
        headers,
        path.join(root, 'native/sqlite-read-window.c'),
        '-o',
        temporary,
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024, stdio: 'pipe' },
    );
    renameSync(temporary, output);
    return true;
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(
    buildMemoryReadWindow()
      ? 'Built bounded SQLite read-window backend'
      : 'SQLite read-window backend unsupported on this platform',
  );
}
