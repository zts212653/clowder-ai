import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { isProcessRunning } from './process-tree.mjs';

export function recoveryListeners(port, { run = spawnSync } = {}) {
  const result = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal) throw result.error ?? new Error('listener observation interrupted');
  if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return [];
  if (result.status !== 0 || !/^\d+(?:\n\d+)*\s*$/.test(result.stdout)) throw new Error('listener absence is unproven');
  return [...new Set(result.stdout.trim().split('\n').map(Number))];
}

export function recoveryGroupRunning(pgid, run = spawnSync) {
  const result = run('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2000 });
  if (result.error || result.signal || result.status !== 0 || !result.stdout.trim())
    throw new Error('preview process group absence is unproven');
  for (const line of result.stdout.trim().split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!match) throw new Error('preview process group observation incomplete');
    if (Number(match[1]) === pgid && !match[2].startsWith('Z')) return true;
  }
  return false;
}

export function assertRecoveryQuiescence(record, owner, coordinates, deps = {}) {
  assertPreviewProcessQuiescence(record, owner, deps);
  const readListeners = deps.readListeners ?? recoveryListeners;
  for (const port of [coordinates.ports.frontend, coordinates.ports.api, coordinates.ports.preview])
    if (readListeners(port).length) throw new Error('named Alpha application port remains occupied');
}

export function assertPreviewProcessQuiescence(
  record,
  owner,
  { isRunning = isProcessRunning, groupRunning = recoveryGroupRunning } = {},
) {
  if (process.platform === 'win32') throw new Error('named Alpha recovery requires POSIX ownership evidence');
  for (const pid of [record.pid, owner.pid])
    if (isRunning(pid) !== false) throw new Error('preview supervisor or cleanup owner is live or unproven');
  for (const pgid of new Set([record.pid, owner.processGroupId]))
    if (groupRunning(pgid) !== false) throw new Error('preview process group is live or unproven');
}

export function assertRecoveryLaunchd(config, record, read = execFileSync) {
  if (record.origin !== 'launchd') return;
  if (
    process.platform !== 'darwin' ||
    record.launchdLabel !== config.launchdLabel ||
    record.plistPath !== config.plistPath
  )
    throw new Error('named Alpha launchd coordinate changed');
  if (realpathSync(config.plistPath) !== config.plistPath) throw new Error('named Alpha launchd plist is linked');
  const plist = JSON.parse(
    read('plutil', ['-convert', 'json', '-o', '-', config.plistPath], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  const allowed = new Set([
    'Label',
    'ProgramArguments',
    'WorkingDirectory',
    'ProcessType',
    'RunAtLoad',
    'KeepAlive',
    'EnvironmentVariables',
    'StandardOutPath',
    'StandardErrorPath',
  ]);
  if (
    Object.keys(plist).some((key) => !allowed.has(key)) ||
    plist.KeepAlive !== false ||
    plist.Label !== config.launchdLabel ||
    plist.WorkingDirectory !== record.cwd ||
    !Array.isArray(plist.ProgramArguments) ||
    plist.ProgramArguments.join(' ') !== record.processCommand ||
    basename(plist.ProgramArguments[1] ?? '') !== 'preview-process-lease-runner.mjs'
  )
    throw new Error('named Alpha launchd job may restart or differs from the recorded runner');
  try {
    const output = read('launchctl', ['print', `gui/${process.getuid()}/${config.launchdLabel}`], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (/^\s*pid =/m.test(output) || !/^\s*state = not running\s*$/m.test(output))
      throw new Error('named Alpha launchd job is live or unproven');
  } catch (error) {
    if (error.status !== 113 || !/Could not find service/.test(String(error.stderr))) throw error;
  }
}
