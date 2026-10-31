import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHD_ENV_KEYS = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'SHELL', 'TMPDIR'];
const SENSITIVE_ENV_KEYS = [
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_SUPERVISOR_PARENT_PID',
  'CAT_CAFE_AGENT_KEY_FILES',
];

export function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ processStartedAt = $p.CreationDate.ToUniversalTime().ToString('o'); processCommand = $p.CommandLine } | ConvertTo-Json -Compress }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );
    try {
      const identity = JSON.parse(result.stdout);
      return identity.processStartedAt && identity.processCommand ? identity : null;
    } catch {
      return null;
    }
  }
  const env = { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' };
  const observed = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'lstart=,stat=,command='], {
    encoding: 'utf8',
    env,
  });
  if (observed.status !== 0) return null;
  // C-locale lstart is 24 columns. Read birth, state and argv in one snapshot:
  // an exited, unreaped runner keeps its birth but has <defunct> instead of argv.
  // It cannot be signalled as an owned live process; stop still requires its
  // successful completion receipt and, for launchd, the job's PID to disappear.
  const fields = observed.stdout.trim().match(/^(.{24})\s+(\S+)\s+([\s\S]+)$/);
  if (!fields || fields[2].startsWith('Z')) return null;
  return { processStartedAt: fields[1], processCommand: fields[3] };
}

export function ownsProcess(record) {
  const current = readProcessIdentity(record?.pid);
  return Boolean(
    current && current.processStartedAt === record.processStartedAt && current.processCommand === record.processCommand,
  );
}

function launchdTarget(config) {
  return `gui/${process.getuid()}/${config.launchdLabel}`;
}

function readLaunchdJob(config) {
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('launchctl', ['print', launchdTarget(config)], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const pidMatch = result.stdout.match(/^\s*pid = (\d+)\s*$/m);
  return { pid: pidMatch ? Number(pidMatch[1]) : null };
}

function matchesLaunchdRecord(config, record) {
  return (
    process.platform === 'darwin' &&
    record?.origin === 'launchd' &&
    record.launchdLabel === config.launchdLabel &&
    record.plistPath === config.plistPath
  );
}

export function ownsLaunchdJob(config, record) {
  if (!matchesLaunchdRecord(config, record)) return false;
  return readLaunchdJob(config) !== null;
}

export function ownsLaunchdProcess(config, record) {
  if (!matchesLaunchdRecord(config, record)) return false;
  const job = readLaunchdJob(config);
  return Boolean(job?.pid && job.pid === record.pid && ownsProcess(record));
}

export function hasRunningLaunchdJob(config, record) {
  return matchesLaunchdRecord(config, record) && Boolean(readLaunchdJob(config)?.pid);
}

export function hasConflictingLaunchdProcess(config, record) {
  if (!matchesLaunchdRecord(config, record)) return false;
  const job = readLaunchdJob(config);
  return Boolean(job?.pid && job.pid !== record.pid);
}

function cleanChildEnv() {
  const env = { ...process.env };
  for (const key of SENSITIVE_ENV_KEYS) delete env[key];
  return env;
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function resolveExecutable(command, cwd, env) {
  if (command.includes('/')) {
    const candidate = command.startsWith('/') ? command : resolve(cwd, command);
    if (!existsSync(candidate)) throw new Error(`preview command does not exist: ${candidate}`);
    return candidate;
  }
  const located = spawnSync('which', [command], { cwd, env, encoding: 'utf8', timeout: 5_000 });
  const candidate = located.status === 0 ? located.stdout.trim().split('\n')[0] : '';
  if (!candidate) throw new Error(`preview command is not available on PATH: ${command}`);
  return candidate;
}

function stableLaunchdPath(cwd, currentPath = '') {
  const cwdBin = join(cwd, 'node_modules', '.bin');
  const candidates = [cwdBin, ...currentPath.split(delimiter)];
  return [...new Set(candidates)]
    .filter((candidate) => {
      if (!isAbsolute(candidate) || candidate.includes('\n') || candidate.includes('/.codex/tmp/')) return false;
      if (candidate.includes('/node_modules/.bin') && candidate !== cwdBin) return false;
      try {
        return statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    })
    .join(delimiter);
}

function writeLaunchdPlist(config) {
  const env = cleanChildEnv();
  env.PATH = stableLaunchdPath(config.cwd, env.PATH);
  let args = config.command.slice(1);
  // BSD ps escapes control characters in argv (e.g. newline => \012). Keep the
  // supervisor's proof single-line while its child receives the original argv.
  if (config.command[1] === fileURLToPath(new URL('./preview-process-lease-runner.mjs', import.meta.url))) {
    const separator = args.indexOf('--');
    if (separator < 0) throw new Error('Invalid preview lease command');
    args = [
      ...args.slice(0, separator),
      '--command-base64',
      Buffer.from(JSON.stringify(args.slice(separator + 1))).toString('base64url'),
    ];
  }
  const command = [resolveExecutable(config.command[0], config.cwd, env), ...args];
  const environmentEntries = LAUNCHD_ENV_KEYS.flatMap((key) => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0
      ? [`    <key>${xmlEscape(key)}</key>`, `    <string>${xmlEscape(value)}</string>`]
      : [];
  }).join('\n');
  const programArguments = command.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join('\n');
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(config.launchdLabel)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArguments,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(config.cwd)}</string>`,
    // Previews serve an explicit interactive request. launchd's default daemon
    // CPU/IO throttling can starve their bounded Git and process identity probes.
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(config.logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(config.logPath)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    environmentEntries,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  const temporaryPath = `${config.plistPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, plist, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, config.plistPath);
  return command;
}

export function removeLaunchdJob(config) {
  if (process.platform !== 'darwin') return;
  spawnSync('launchctl', ['bootout', launchdTarget(config)], {
    encoding: 'utf8',
    timeout: 5_000,
  });
}

export async function captureLaunchdIdentity(pid, launchdLabel, readIdentity = readProcessIdentity, proof = {}) {
  if (!proof.expectedCommand || !proof.readJobPid) return null;
  // During exec, native ps can expose only the kernel's parenthesized comm.
  // Neither proxy form is final proof: the job PID and birth must stay fixed
  // until the complete expected supervisor argv is observed.
  const proxies = new Set([`xpcproxy ${launchdLabel}`, '(xpcproxy)']);
  let birth;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (proof.readJobPid() !== pid) return null;
    const identity = readIdentity(pid);
    proof.onObservation?.({ pid, expectedCommand: proof.expectedCommand, identity });
    // launchctl can publish a PID before xpcproxy execs the owned lease runner.
    // Recording that transient argv makes the existing exact identity fence kill a healthy startup.
    if (identity) {
      birth ??= identity.processStartedAt;
      if (identity.processStartedAt !== birth) return null;
      if (identity.processCommand === proof.expectedCommand) return identity;
      if (!proxies.has(identity.processCommand)) return null;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return null;
}

async function waitForLaunchdPid(config, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const job = readLaunchdJob(config);
    if (job?.pid) return job.pid;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  } while (Date.now() < deadline);
  return null;
}

export async function launchWithLaunchd(config, { onObservation } = {}) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  removeLaunchdJob(config);
  const expectedCommand = writeLaunchdPlist(config).join(' ');
  const bootstrap = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, config.plistPath], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (bootstrap.status !== 0) {
    rmSync(config.plistPath, { force: true });
    throw new Error(`launchd could not start the preview: ${(bootstrap.stderr || bootstrap.stdout).trim()}`);
  }
  const pid = await waitForLaunchdPid(config);
  if (!pid) {
    removeLaunchdJob(config);
    rmSync(config.plistPath, { force: true });
    throw new Error(`launchd preview exited before publishing a PID; see ${config.logPath}`);
  }
  const identity = await captureLaunchdIdentity(pid, config.launchdLabel, readProcessIdentity, {
    expectedCommand,
    onObservation,
    readJobPid: () => readLaunchdJob(config)?.pid,
  });
  if (!identity) {
    removeLaunchdJob(config);
    rmSync(config.plistPath, { force: true });
    throw new Error(`launchd preview did not publish its final process identity; see ${config.logPath}`);
  }
  return {
    origin: 'launchd',
    launchdLabel: config.launchdLabel,
    plistPath: config.plistPath,
    pid,
    ...(identity ?? {}),
  };
}

export async function launchDetached(config) {
  const logFd = openSync(config.logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(config.command[0], config.command.slice(1), {
      cwd: config.cwd,
      detached: true,
      windowsHide: true,
      env: cleanChildEnv(),
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const identity = await captureDetachedIdentity(child.pid);
  if (!identity) {
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM');
    } catch {}
    throw new Error(`started PID ${child.pid} but could not capture its process identity`);
  }
  return { origin: 'detached', pid: child.pid, ...identity };
}

async function captureDetachedIdentity(pid) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const identity = readProcessIdentity(pid);
    if (identity) return identity;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}
