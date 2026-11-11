import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;
const LOG_ROOT = '/var/log/powermanagement';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const FORMAT = '$(Time)\t$(TimeNanoSec)\t$(com.apple.iokit.domain)\t$(uuid)';
const READ_BUDGET_MS = 5_000;
// Sleep marks the beginning of a transition, before the process stops polling
// (1.7s early in the captured wake). Allow at most a minute of that lead time
// when deciding to wait, never when calculating confirmed sleep credit.
const SLEEP_TRANSITION_SLACK_MS = 60_000;
const wakeWait = new Int32Array(new SharedArrayBuffer(4));

function powerEvent(line) {
  const [seconds, nanos, kind, uuid, extra] = line.split('\t');
  if (
    extra !== undefined ||
    !/^\d+$/u.test(seconds ?? '') ||
    !/^\d{1,9}$/u.test(nanos ?? '') ||
    !['Sleep', 'DarkWake', 'Wake'].includes(kind) ||
    !UUID.test(uuid ?? '') ||
    !Number.isSafeInteger(Number(seconds))
  )
    return null;
  return { at: Number(seconds) * 1000 + Number(nanos) / 1_000_000, kind, uuid };
}

export function parseMacSleepEvidence(output) {
  let sleeping = null;
  let awaitingFullWake = null;
  const confirmedSleep = [];
  let previousAt = -Infinity;
  for (const line of output.split('\n').filter(Boolean)) {
    const event = powerEvent(line);
    if (!event) return { status: 'unavailable', reason: 'invalid power event' };
    const { at, kind, uuid } = event;
    if (at < previousAt) {
      return { status: 'unavailable', reason: 'unordered power events' };
    }
    previousAt = at;
    if (kind === 'Sleep') {
      // A new sleep replaces an unpaired record; missing wakes cannot make an
      // earlier interval consume awake time between two distinct sleeps.
      sleeping = { at, uuid };
      awaitingFullWake = null;
      continue;
    }
    if (sleeping) {
      const start = sleeping;
      sleeping = null;
      if (uuid !== start.uuid) continue;
      confirmedSleep.push({
        evidenceId: `mac-power:${uuid}:${start.at}:${at}`,
        startedAt: start.at,
        endedAt: at,
        wakeKind: kind === 'DarkWake' ? 'dark' : 'full',
      });
      awaitingFullWake = kind === 'DarkWake' ? uuid : null;
      continue;
    }
    if (kind === 'Wake' && awaitingFullWake) {
      if (uuid === awaitingFullWake) {
        confirmedSleep.push({
          evidenceId: `mac-power:full-wake:${uuid}:${at}`,
          startedAt: at,
          endedAt: at,
          wakeKind: 'full',
        });
      }
      awaitingFullWake = null;
    }
  }
  return {
    status: 'available',
    confirmedSleep,
    ...(sleeping ? { pendingSleep: { startedAt: sleeping.at } } : {}),
  };
}

export function readMacSleepEvidence(
  { from, to, timeoutMs = READ_BUDGET_MS },
  {
    platform = process.platform,
    exists = existsSync,
    execute = execFileSync,
    now = () => performance.now(),
    wait = (ms) => Atomics.wait(wakeWait, 0, 0, ms),
  } = {},
) {
  if (platform !== 'darwin') return { status: 'unavailable', reason: 'unsupported power source' };
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from < 0 ||
    to < from ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return { status: 'unavailable', reason: 'invalid power window' };
  }
  let evidence = { status: 'unavailable', reason: 'power log read failed' };
  try {
    const candidates = [];
    // ASL filenames use local dates. Adjacent UTC dates cover both timezone
    // directions, including a sleep logged just before a date boundary.
    for (let day = Math.floor(from / DAY_MS) - 1; day <= Math.floor(to / DAY_MS) + 1; day += 1) {
      const name = `${new Date(day * DAY_MS).toISOString().slice(0, 10).replaceAll('-', '.')}.asl`;
      candidates.push(path.join(LOG_ROOT, name));
    }
    const query = [
      '-T',
      'sec',
      '-F',
      FORMAT,
      '-k',
      'Time',
      'Nle',
      String(Math.ceil(to / 1000) + 1),
      '-k',
      'com.apple.iokit.domain',
      'Req',
      '^(Sleep|DarkWake|Wake)$',
    ];
    const deadline = now() + Math.min(READ_BUDGET_MS, timeoutMs);
    while (now() < deadline) {
      // A Wake just past local midnight can create its date file after the
      // first read; keep the date range fixed but discover new files each time.
      const files = candidates.filter((file) => exists(file));
      if (!files.length) return { status: 'unavailable', reason: 'power log unavailable' };
      const readRemainingMs = Math.floor(deadline - now());
      if (readRemainingMs <= 0) break;
      const output = execute('/usr/bin/syslog', [...files.flatMap((file) => ['-f', file]), ...query], {
        encoding: 'utf8',
        timeout: readRemainingMs,
        killSignal: 'SIGKILL',
        maxBuffer: 1_048_576,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      evidence = parseMacSleepEvidence(output);
      // The process can resume before ASL publishes the matching Wake. Keep
      // this read open only for an OS-observed, unfinished Sleep; all attempts
      // share the original read budget and retain the requested time window.
      const pendingAt = evidence.pendingSleep?.startedAt;
      if (evidence.status !== 'available' || !(pendingAt >= from - SLEEP_TRANSITION_SLACK_MS && pendingAt <= to))
        return evidence;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      wait(Math.min(100, remainingMs));
    }
    return evidence;
  } catch (error) {
    // A failed reread cannot erase pairs already obtained from this same
    // bounded query. An unpaired Sleep still supplies no credit.
    if (evidence.status === 'available') return evidence;
    return {
      status: 'unavailable',
      reason: `power log read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
