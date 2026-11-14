import { execFile } from 'node:child_process';
import type { UnixProcessIdentity } from '../../utils/cli-process-ownership.js';

/** A previously proven member cannot escape cleanup merely by disappearing from the environment census. */
export function retainLiveManagedAttemptMembers(
  known: Map<number, UnixProcessIdentity>,
  discovered: readonly UnixProcessIdentity[],
): Promise<UnixProcessIdentity[] | null> {
  for (const member of discovered) known.set(member.pid, member);
  if (known.size === 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-p', [...known.keys()].join(','), '-o', 'pid=,lstart=,stat='],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !(error.code === 1 && !stdout.trim() && !stderr.trim())) return resolve(null);
        if (stderr.trim()) return resolve(null);
        const alive = new Set<number>();
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const fields = line.trim().split(/\s+/u);
          if (fields.length !== 7 || !/^\d+$/u.test(fields[0]!)) return resolve(null);
          const pid = Number(fields[0]);
          const member = known.get(pid);
          if (member?.startedAt === fields.slice(1, 6).join(' ') && !fields[6]!.startsWith('Z')) alive.add(pid);
        }
        for (const pid of known.keys()) if (!alive.has(pid)) known.delete(pid);
        resolve([...known.values()]);
      },
    );
  });
}
