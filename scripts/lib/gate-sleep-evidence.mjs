import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;
const LOG_ROOT = '/var/log/powermanagement';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const FORMAT = '$(Time)\t$(TimeNanoSec)\t$(com.apple.iokit.domain)\t$(uuid)';

export function parseMacSleepEvidence(output) {
  let sleeping = null;
  const confirmedSleep = [];
  let previousAt = -Infinity;
  for (const line of output.split('\n').filter(Boolean)) {
    const [seconds, nanos, kind, uuid, extra] = line.split('\t');
    if (
      extra !== undefined ||
      !/^\d+$/u.test(seconds ?? '') ||
      !/^\d{1,9}$/u.test(nanos ?? '') ||
      !['Sleep', 'DarkWake', 'Wake'].includes(kind) ||
      !UUID.test(uuid ?? '')
    )
      return { status: 'unavailable', reason: 'invalid power event' };
    const at = Number(seconds) * 1000 + Number(nanos) / 1_000_000;
    if (!Number.isSafeInteger(Number(seconds)) || at < previousAt) {
      return { status: 'unavailable', reason: 'unordered power events' };
    }
    previousAt = at;
    if (kind === 'Sleep') {
      // A new sleep replaces an unpaired record; missing wakes cannot make an
      // earlier interval consume awake time between two distinct sleeps.
      sleeping = { at, uuid };
    } else if (sleeping) {
      if (uuid === sleeping.uuid && at >= sleeping.at) {
        confirmedSleep.push({
          evidenceId: `mac-power:${uuid}:${sleeping.at}:${at}`,
          startedAt: sleeping.at,
          endedAt: at,
        });
      }
      sleeping = null;
    }
  }
  return { status: 'available', confirmedSleep };
}

export function readMacSleepEvidence(
  { from, to },
  { platform = process.platform, exists = existsSync, execute = execFileSync } = {},
) {
  if (platform !== 'darwin') return { status: 'unavailable', reason: 'unsupported power source' };
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
    return { status: 'unavailable', reason: 'invalid power window' };
  }
  try {
    const files = [];
    // ASL filenames use local dates. Adjacent UTC dates cover both timezone
    // directions, including a sleep logged just before a date boundary.
    for (let day = Math.floor(from / DAY_MS) - 1; day <= Math.floor(to / DAY_MS) + 1; day += 1) {
      const name = `${new Date(day * DAY_MS).toISOString().slice(0, 10).replaceAll('-', '.')}.asl`;
      const file = path.join(LOG_ROOT, name);
      if (exists(file)) files.push(file);
    }
    if (!files.length) return { status: 'unavailable', reason: 'power log unavailable' };
    const output = execute(
      '/usr/bin/syslog',
      [
        ...files.flatMap((file) => ['-f', file]),
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
      ],
      {
        encoding: 'utf8',
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1_048_576,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return parseMacSleepEvidence(output);
  } catch {
    return { status: 'unavailable', reason: 'power log read failed' };
  }
}
