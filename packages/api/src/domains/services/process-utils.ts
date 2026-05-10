import { execSync, spawn } from 'node:child_process';

const IS_WIN32 = process.platform === 'win32';

/** Check if a PID's command line matches the service (prevents killing unrelated processes). */
export function isServiceProcess(pid: number, manifest: { id: string; scripts: { start?: string } }): boolean {
  const startScript = manifest.scripts.start;
  if (!startScript) return false;
  try {
    let cmd: string;
    if (IS_WIN32) {
      cmd = execSync(`wmic process where "ProcessId=${pid}" get CommandLine /FORMAT:LIST`, {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
    } else {
      cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf-8', timeout: 2000 }).trim();
    }
    const scriptBasename = startScript.replace(/.*\//, '');
    if (cmd.includes(scriptBasename) || cmd.includes(startScript)) return true;
    const serviceDir = startScript.replace(/\/[^/]+$/, '');
    if (serviceDir && cmd.includes(serviceDir)) return true;
    const prefix = scriptBasename.replace(/[-_](server|start|run)\.\w+$/, '');
    if (prefix.length >= 3 && cmd.includes(prefix)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Check if a process matching a command-line pattern is running. */
export async function checkProcessByPattern(pattern: string): Promise<boolean> {
  return new Promise((resolve) => {
    let cmd: ReturnType<typeof spawn>;
    if (IS_WIN32) {
      cmd = spawn('wmic', ['process', 'where', `CommandLine like '%${pattern}%'`, 'get', 'ProcessId'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      cmd = spawn('pgrep', ['-f', pattern], { stdio: ['pipe', 'pipe', 'pipe'] });
    }
    let out = '';
    cmd.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    cmd.on('close', () => resolve(out.trim().length > 0));
    cmd.on('error', () => resolve(false));
  });
}

/** Find PIDs listening on a given port (cross-platform). */
export function findPidsByPort(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    let cmd: ReturnType<typeof spawn>;
    if (IS_WIN32) {
      cmd = spawn('cmd', ['/c', `netstat -ano | findstr "LISTENING" | findstr ":${port} "`], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      cmd = spawn('lsof', ['-ti', `TCP:${port}`, '-sTCP:LISTEN'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    let stdout = '';
    cmd.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    cmd.on('error', () => resolve([]));
    cmd.on('close', () => {
      const myPid = process.pid;
      let pids: number[];
      if (IS_WIN32) {
        pids = stdout
          .trim()
          .split('\n')
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            return Number(parts[parts.length - 1]);
          })
          .filter((n) => Number.isFinite(n) && n > 0 && n !== myPid);
      } else {
        pids = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n) && n > 0 && n !== myPid);
      }
      resolve(pids);
    });
  });
}
