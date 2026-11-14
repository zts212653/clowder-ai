import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/** Validate the co-located Desktop launch contract, independently of release version/formatting. */
export function resolveDshDesktopLaunch(command: string, args: readonly string[]) {
  if (!/^dsh\.cmd$/i.test(basename(command))) return null;
  try {
    const lines = readFileSync(command, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^(?:rem\s|::)/i.test(line));
    if (
      lines.length !== 5 ||
      !/^@echo\s+off$/i.test(lines[0]!) ||
      !/^setlocal\s+DisableDelayedExpansion$/i.test(lines[1]!) ||
      !/^set\s+"ELECTRON_RUN_AS_NODE=1"$/i.test(lines[2]!) ||
      !/^exit\s+\/b\s+%errorlevel%$/i.test(lines[4]!)
    )
      return null;
    const launch = /^"(%~dp0[^"\r\n]+)"\s+--expose-internals\s+"(%~dp0[^"\r\n]+)"\s+%\*$/i.exec(lines[3]!);
    if (!launch) return null;
    const root = resolve(dirname(command), '../../../..');
    const resources = join(root, 'resources');
    const executable = join(root, 'DeepSeek Harness.exe');
    const entry = join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
    if (
      resolve(dirname(command), launch[1]!.slice(5).replaceAll('\\', '/')).toLowerCase() !== executable.toLowerCase() ||
      resolve(dirname(command), launch[2]!.slice(5).replaceAll('\\', '/')).toLowerCase() !== entry.toLowerCase()
    )
      return null;
    if (!existsSync(executable) || !existsSync(join(resources, 'app.asar'))) return null;
    return {
      command: executable,
      args: ['--expose-internals', entry, ...args] satisfies [string, string, ...string[]],
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
  const { processes } = await readDesktopState().catch(() => ({ processes: [] }));
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
