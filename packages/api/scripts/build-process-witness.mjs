import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Node-API is built at release time; observing never starts a compiler or a subprocess. */
export function buildProcessWitness(output = path.join(root, 'dist/native/process-witness.node')) {
  if (process.platform !== 'darwin') return false;
  const headers = path.resolve(path.dirname(realpathSync(process.execPath)), '../include/node');
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
        '-bundle',
        '-undefined',
        'dynamic_lookup',
        '-DNAPI_VERSION=8',
        '-I',
        headers,
        '-Wall',
        '-Wextra',
        '-Werror',
        path.join(root, 'native/process-witness.c'),
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

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(buildProcessWitness() ? 'Built passive process witness' : 'Process witness unsupported on this platform');
