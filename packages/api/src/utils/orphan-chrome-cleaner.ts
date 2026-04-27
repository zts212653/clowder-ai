import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const USER_DATA_DIR_RE = /--user-data-dir=\S*agent-browser-chrome/;

export interface OrphanCleanResult {
  found: number;
  killed: number;
  failedPids: number[];
  durationMs: number;
}

interface CleanerLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface OrphanChromeDeps {
  listProcesses: () => Promise<string>;
  killProcess: (pid: number) => void;
}

function isChromeBinary(args: string): boolean {
  return (
    args.startsWith('/Applications/Google Chrome.app/') ||
    args.startsWith('/Applications/Chromium.app/') ||
    /^\/(?:usr|opt|snap)\S*\/(?:google-chrome|chromium|chrome)/.test(args)
  );
}

export function parseOrphanPids(psOutput: string, ownPid: number): number[] {
  return psOutput
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) return null;
      const ppid = Number.parseInt(m[1], 10);
      const pid = Number.parseInt(m[2], 10);
      const args = m[3];
      if (pid === ownPid) return null;
      if (ppid !== 1) return null;
      if (!isChromeBinary(args)) return null;
      if (!USER_DATA_DIR_RE.test(args)) return null;
      return pid;
    })
    .filter((pid): pid is number => pid !== null);
}

const defaultDeps: OrphanChromeDeps = {
  async listProcesses() {
    const { stdout } = await execFileAsync('ps', ['-eo', 'ppid=,pid=,args='], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  },
  killProcess(pid: number) {
    process.kill(pid, 'SIGKILL');
  },
};

export async function cleanOrphanAgentBrowserChrome(
  log: CleanerLog,
  deps: OrphanChromeDeps = defaultDeps,
): Promise<OrphanCleanResult> {
  const start = Date.now();
  if (process.platform === 'win32') {
    return { found: 0, killed: 0, failedPids: [], durationMs: Date.now() - start };
  }

  let pids: number[];
  try {
    const psOutput = await deps.listProcesses();
    pids = parseOrphanPids(psOutput, process.pid);
  } catch (err) {
    log.warn(`[orphan-chrome] Failed to list processes: ${String(err)}`);
    return { found: 0, killed: 0, failedPids: [], durationMs: Date.now() - start };
  }

  if (pids.length === 0) {
    return { found: 0, killed: 0, failedPids: [], durationMs: Date.now() - start };
  }

  log.info(`[orphan-chrome] Found ${pids.length} orphan agent-browser Chrome process(es): ${pids.join(', ')}`);

  let killed = 0;
  const failedPids: number[] = [];
  for (const pid of pids) {
    try {
      deps.killProcess(pid);
      killed++;
    } catch {
      failedPids.push(pid);
    }
  }

  const durationMs = Date.now() - start;
  if (killed > 0) {
    log.info(`[orphan-chrome] Killed ${killed}/${pids.length} orphan(s) in ${durationMs}ms`);
  }
  if (failedPids.length > 0) {
    log.warn(`[orphan-chrome] Failed to kill PIDs: ${failedPids.join(', ')}`);
  }

  return { found: pids.length, killed, failedPids, durationMs };
}
