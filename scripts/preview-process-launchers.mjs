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

const LAUNCHD_ENV_KEYS = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'SHELL', 'TMPDIR'];
const SENSITIVE_ENV_KEYS = [
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_SUPERVISOR_PARENT_PID',
  'CAT_CAFE_AGENT_KEY_FILES',
];

function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const started = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (started.status !== 0 || command.status !== 0) return null;
  const processStartedAt = started.stdout.trim();
  const processCommand = command.stdout.trim();
  return processStartedAt && processCommand ? { processStartedAt, processCommand } : null;
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
  return Boolean(job?.pid && job.pid === record.pid);
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
  const command = [resolveExecutable(config.command[0], config.cwd, env), ...config.command.slice(1)];
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
}

export function removeLaunchdJob(config) {
  if (process.platform !== 'darwin') return;
  spawnSync('launchctl', ['bootout', launchdTarget(config)], {
    encoding: 'utf8',
    timeout: 5_000,
  });
}

async function captureIdentity(pid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const identity = readProcessIdentity(pid);
    if (identity) return identity;
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

export async function launchWithLaunchd(config) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  removeLaunchdJob(config);
  writeLaunchdPlist(config);
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
  const identity = await captureIdentity(pid);
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
      env: cleanChildEnv(),
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const identity = await captureIdentity(child.pid);
  if (!identity) {
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM');
    } catch {}
    throw new Error(`started PID ${child.pid} but could not capture its process identity`);
  }
  return { origin: 'detached', pid: child.pid, ...identity };
}
