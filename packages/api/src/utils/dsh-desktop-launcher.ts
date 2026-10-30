import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const launcher = [
  '@echo off',
  'setlocal DisableDelayedExpansion',
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  'exit /b %errorlevel%',
].join('\n');

/** The official Desktop public launcher is not an npm shim: its entry lives
 * inside ASAR and must run in its own Electron's Node mode. Recognize only the
 * exact launcher and fixed sibling layout; arbitrary wrappers remain manual. */
export function resolveDshDesktopLauncher(command: string, args: readonly string[]) {
  if (process.platform !== 'win32' || !isAbsolute(command) || basename(command).toLowerCase() !== 'dsh.cmd') return;
  try {
    const info = lstatSync(command);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) return;
    if (readFileSync(command, 'utf8').replace(/\r\n/g, '\n').trim() !== launcher) return;
    const installation = resolve(dirname(command), '../../../..');
    if (resolve(command).toLowerCase() !== join(installation, 'resources/runtime/cli/bin/dsh.cmd').toLowerCase())
      return;
    const executable = join(installation, 'DeepSeek Harness.exe');
    const archive = join(installation, 'resources/app.asar');
    if (
      ![executable, archive].every((path) => {
        const stat = lstatSync(path);
        return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
      })
    )
      return;
    return {
      command: executable,
      args: ['--expose-internals', join(archive, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), ...args],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  } catch {
    return;
  }
}
