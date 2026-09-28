import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
interface ProcessRow {
  pid: number;
  group: number;
  rss: number;
  cpu: number;
}

function seconds(value: string): number {
  const [dayPart, clock] = value.includes('-') ? value.split('-') : ['0', value];
  const days = Number(dayPart);
  const fields = (clock ?? '').split(':').map(Number);
  if (!Number.isSafeInteger(days) || days < 0 || fields.length < 2 || fields.length > 3)
    throw new Error('process resource monitor unavailable');
  if (fields.some((n) => !Number.isFinite(n))) throw new Error('process resource monitor unavailable');
  return days * 86400 + fields.reduce((total, n) => total * 60 + n, 0);
}

async function rows(): Promise<ProcessRow[]> {
  const { stdout } = await exec('ps', ['-axo', 'pid=,pgid=,rss=,time='], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid, group, rss, cpu] = line.trim().split(/\s+/);
      if (!pid || !group || !rss || !cpu) throw new Error('process resource monitor unavailable');
      return { pid: Number(pid), group: Number(group), rss: Number(rss) * 1024, cpu: seconds(cpu) };
    });
}

/** The group must belong to this freshly spawned detached Chromium, never a shared process. */
export async function monitorPrivateBrowser(pid: number, abort: (reason: Error) => void) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('resource monitor unavailable on this platform');
  const initial = await rows();
  if (!initial.some((row) => row.pid === pid && row.group === pid))
    throw new Error('private browser process group unavailable');
  const cpuByPid = new Map<number, number>();
  let peakRssBytes = 0;
  let cpuSeconds = 0;
  let stopped = false;
  let killed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const sample = async () => {
    const owned = (await rows()).filter((row) => row.group === pid);
    if (!owned.some((row) => row.pid === pid)) throw new Error('private browser exited');
    peakRssBytes = Math.max(
      peakRssBytes,
      owned.reduce((total, row) => total + row.rss, 0),
    );
    for (const row of owned) cpuByPid.set(row.pid, Math.max(cpuByPid.get(row.pid) ?? 0, row.cpu));
    cpuSeconds = [...cpuByPid.values()].reduce((total, cpu) => total + cpu, 0);
    // Summed RSS counts shared Chromium pages in multiple processes. The private
    // process tree has a finite 2 GiB ceiling in addition to its 256 MiB JS heap.
    if (peakRssBytes > 2 * 1024 * 1024 * 1024 || cpuSeconds > 15)
      throw new Error(`materializer resource budget exceeded: rss=${peakRssBytes}, cpu=${cpuSeconds}`);
  };
  const schedule = () => {
    timer = setTimeout(() => {
      pending = sample()
        .catch((error) => {
          if (!stopped) abort(error as Error);
        })
        .finally(() => {
          if (!stopped) schedule();
        });
    }, 200);
    timer.unref();
  };
  await sample();
  schedule();
  return {
    metrics: () => ({ peakRssBytes, cpuSeconds }),
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await pending;
    },
    kill() {
      if (killed) return;
      killed = true;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        // macOS can report EPERM for an already exiting sandboxed group. The
        // mandatory post-close process observation below decides disposal.
        if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    },
    async assertDisposed() {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (!(await rows()).some((row) => row.group === pid && row.rss > 0)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('materializer process cleanup incomplete');
    },
  };
}
