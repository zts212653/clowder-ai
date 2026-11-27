import { execFile } from 'node:child_process';
import { processTableEnvironment } from '../../utils/cli-process-environment.js';
import { isCLocaleProcessStart } from '../../utils/cli-process-legacy-start.js';
import type { UnixProcessIdentity } from '../../utils/cli-process-ownership.js';

/** Non-zombie start times by PID, or null when the read cannot prove anything. */
function readLiveStarts(pids: readonly number[], env: NodeJS.ProcessEnv): Promise<Map<number, string> | null> {
  if (pids.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-p', pids.join(','), '-o', 'pid=,lstart=,stat='],
      { encoding: 'utf8', env, timeout: 2000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !(error.code === 1 && !stdout.trim() && !stderr.trim())) return resolve(null);
        if (stderr.trim()) return resolve(null);
        const live = new Map<number, string>();
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const fields = line.trim().split(/\s+/u);
          if (fields.length !== 7 || !/^\d+$/u.test(fields[0]!)) return resolve(null);
          if (!fields[6]!.startsWith('Z')) live.set(Number(fields[0]), fields.slice(1, 6).join(' '));
        }
        resolve(live);
      },
    );
  });
}

/**
 * A previously proven member cannot escape cleanup merely by disappearing from the environment census.
 * Members recorded before the #2025 locale fix are re-read exactly as that build read them (inherited
 * locale), so the format change can neither prove a live legacy member dead nor change how a dead one ends.
 */
export async function retainLiveManagedAttemptMembers(
  known: Map<number, UnixProcessIdentity>,
  discovered: readonly UnixProcessIdentity[],
): Promise<UnixProcessIdentity[] | null> {
  for (const member of discovered) known.set(member.pid, member);
  if (known.size === 0) return [];
  const members = [...known.values()];
  const legacyPids = members.filter((member) => !isCLocaleProcessStart(member.startedAt)).map(({ pid }) => pid);
  const currentPids = members.filter((member) => isCLocaleProcessStart(member.startedAt)).map(({ pid }) => pid);
  const [currentLive, legacyLive] = await Promise.all([
    readLiveStarts(currentPids, processTableEnvironment()),
    readLiveStarts(legacyPids, process.env),
  ]);
  if (currentLive === null || legacyLive === null) return null;
  for (const member of members) {
    const live = isCLocaleProcessStart(member.startedAt) ? currentLive : legacyLive;
    if (live.get(member.pid) !== member.startedAt) known.delete(member.pid);
  }
  return [...known.values()];
}
