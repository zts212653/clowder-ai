import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

interface NpmRuntime {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
}

export function resolveNpmInvocation(
  npmBin: string,
  runtime: NpmRuntime = process,
): { command: string; prefixArgs: string[] } {
  // An explicit npm CLI entrypoint is JavaScript, not a launcher. Node can run
  // it everywhere, including Windows where execFile cannot start npm.cmd.
  if (/\.(?:c|m)?js$/i.test(npmBin)) return { command: runtime.execPath, prefixArgs: [npmBin] };
  if (runtime.platform !== 'win32') return { command: npmBin, prefixArgs: [] };
  const lower = npmBin.toLowerCase();
  if (lower !== 'npm' && !lower.endsWith('.cmd')) return { command: npmBin, prefixArgs: [] };
  // execFile cannot launch npm.cmd on Windows. Run npm's JS entrypoint with
  // the same Node binary instead, preserving the caller's npm version.
  const candidates = [
    resolve(dirname(runtime.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(isAbsolute(npmBin) ? [resolve(dirname(npmBin), 'node_modules', 'npm', 'bin', 'npm-cli.js')] : []),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: runtime.execPath, prefixArgs: [candidate] };
  }
  return { command: npmBin, prefixArgs: [] };
}
