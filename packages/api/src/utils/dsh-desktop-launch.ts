import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

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
      ] satisfies [string, string, ...string[]],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  } catch {
    return null;
  }
}

/** Read Desktop installation metadata; no Harness process or package manager is started. */
export async function findDshDesktopCommands(installRoots?: string[]) {
  let roots = installRoots;
  if (!roots) {
    if (process.platform !== 'win32') return [];
    const script = `$ProgressPreference='SilentlyContinue'; ConvertTo-Json -InputObject @(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'DeepSeek Harness' } | ForEach-Object { $_.InstallLocation })`;
    try {
      const stdout = await runDesktopQuery(script, 3_000);
      const value: unknown = JSON.parse(stdout);
      if (!Array.isArray(value) || !value.every((root): root is string => typeof root === 'string')) return [];
      roots = value;
    } catch {
      return [];
    }
  }
  const commands = [
    ...new Set(
      roots
        .map((root) => join(root, 'resources/runtime/cli/bin/dsh.cmd'))
        .filter((command) => resolveDshDesktopLaunch(command, []))
        .map((command) => realpathSync(command)),
    ),
  ];
  if (commands.length < 2 || installRoots) return commands;
  const { processes } = await readDesktopState();
  const running = commands.filter(
    (command) => runningProfiles(resolveDshDesktopLaunch(command, [])!.command, processes).length,
  );
  return running.length === 1 ? running : commands;
}

function runDesktopQuery(script: string, timeout: number) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

async function readDesktopState() {
  const script = `ConvertTo-Json -Depth 3 @{ userHome=[Environment]::GetEnvironmentVariable('DSH_HOME','User'); machineHome=[Environment]::GetEnvironmentVariable('DSH_HOME','Machine'); processes=@(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Select-Object ExecutablePath,CommandLine) }`;
  const stdout = await runDesktopQuery(script, 5_000);
  return z
    .object({
      userHome: z.string().nullable(),
      machineHome: z.string().nullable(),
      processes: z.array(z.object({ ExecutablePath: z.string().nullable(), CommandLine: z.string().nullable() })),
    })
    .parse(JSON.parse(stdout));
}

function runningProfiles(executable: string, processes: Awaited<ReturnType<typeof readDesktopState>>['processes']) {
  const entry = join(
    dirname(executable),
    'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
  );
  return processes.flatMap((process) => {
    if (!process.ExecutablePath || resolve(process.ExecutablePath).toLowerCase() !== resolve(executable).toLowerCase())
      return [];
    const args = (process.CommandLine?.match(/"[^"]*"|\S+/g) ?? []).map((arg) => arg.replace(/^"|"$/g, ''));
    const index = args.findIndex((arg) => resolve(arg).toLowerCase() === entry.toLowerCase());
    const profile = args[index + 2];
    return index >= 0 && profile && isAbsolute(profile) && /[\\/]profiles[\\/]desktop$/i.test(profile) ? [profile] : [];
  });
}

/** Bind a running Desktop's profile, or the native HOME candidate when it is not running. */
export async function resolveDshDesktopHome(command: string) {
  const plan = resolveDshDesktopLaunch(command, []);
  if (!plan) throw Error('dsh_setup_custom_startup');
  const value = await readDesktopState();
  const unique = [...new Set(runningProfiles(plan.command, value.processes).map((profile) => realpathSync(profile)))];
  if (unique.length > 1) throw Error('dsh_setup_desktop_ambiguous');
  if (unique[0]) return { nativeHome: dirname(dirname(unique[0])), nativeCwd: unique[0] };
  const configured = [value.userHome, value.machineHome, process.env.DSH_HOME].find((value) => value?.trim());
  const candidate = configured?.replace(/^~(?=$|[\\/])/, homedir()) ?? join(homedir(), '.dsh');
  if (!isAbsolute(candidate)) throw Error('dsh_setup_profile_required');
  const nativeHome = realpathSync(candidate);
  return { nativeHome, nativeCwd: join(nativeHome, 'profiles/desktop') };
}
