import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const desktopShim = [
  '@echo off',
  'setlocal DisableDelayedExpansion',
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  'exit /b %errorlevel%',
].join('\n');

/** Only the shipped Desktop shim is normalized; arbitrary wrappers keep their existing handling. */
export function resolveDshDesktopLaunch(command: string, args: readonly string[]) {
  if (!/^dsh\.cmd$/i.test(basename(command))) return null;
  try {
    if (readFileSync(command, 'utf8').replaceAll('\r\n', '\n').trim() !== desktopShim) return null;
    const root = resolve(dirname(command), '../../../..');
    const resources = join(root, 'resources');
    const metadata: unknown = JSON.parse(readFileSync(join(resources, 'runtime/primary-runtime/runtime.json'), 'utf8'));
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('desktopVersion' in metadata) ||
      typeof metadata.desktopVersion !== 'string' ||
      !['0.2.1-rc.2', '0.2.2-rc.1'].includes(metadata.desktopVersion)
    )
      return null;
    const executable = join(root, 'DeepSeek Harness.exe');
    if (!existsSync(executable) || !existsSync(join(resources, 'app.asar'))) return null;
    return {
      command: executable,
      args: [
        '--expose-internals',
        join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'),
        ...args,
      ],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  } catch {
    return null;
  }
}

/** Read Desktop installation metadata; no Harness process or package manager is started. */
export function findDshDesktopCommand(installRoots?: string[]) {
  let roots = installRoots;
  if (!roots) {
    if (process.platform !== 'win32') return undefined;
    const script = `$ProgressPreference='SilentlyContinue'; ConvertTo-Json -InputObject @(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'DeepSeek Harness' } | ForEach-Object { $_.InstallLocation })`;
    try {
      const output = execFileSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: 3_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const value: unknown = JSON.parse(output);
      if (!Array.isArray(value) || !value.every((root): root is string => typeof root === 'string')) return undefined;
      roots = value;
    } catch {
      return undefined;
    }
  }
  return roots
    .map((root) => join(root, 'resources/runtime/cli/bin/dsh.cmd'))
    .find((command) => resolveDshDesktopLaunch(command, []));
}
