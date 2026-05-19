import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const STALE_AGENT_BROWSER_CHROME_SECONDS = 60 * 60;
const USER_DATA_DIR_RE = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/;

// LL-056 extension: ownership is by user-data-dir, not symptom field — list every
// known headless owner so a leak from any of them gets cleaned. Markers must be
// specific enough that user-managed manual debug dirs are NOT swept up.
const TRACKED_USER_DATA_DIR_OWNERS = [
  'agent-browser-chrome', // vercel-labs / minhlucvan agent-browser-mcp
  'rod/user-data', // github.com/go-rod/rod (e.g. xiaohongshu-mcp)
  'playwright_chromiumdev_profile-', // Playwright default ephemeral temp profile
  'puppeteer_dev_chrome_profile-', // puppeteer default temp profile
];

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

interface ProcessEntry {
  ppid: number;
  pid: number;
  elapsedSeconds?: number;
  userDataDir: string;
}

function isChromeBinary(args: string): boolean {
  // Extract the binary-path prefix (everything before the first ` -<flag>`).
  // Helper binary names contain spaces ("Chromium Helper (Renderer)") so \S*-style
  // regexes can't span them — but binary names never start with `-`, so the
  // first " -" reliably marks the flag boundary. Restricting the helper substring
  // check to this prefix prevents prompt-text false matches (砚砚 R2 class).
  const binaryPath = args.split(' -')[0];
  return (
    args.startsWith('/Applications/Google Chrome.app/') ||
    args.startsWith('/Applications/Chromium.app/') ||
    /^\/(?:usr|opt|snap)\S*\/(?:google-chrome|chromium|chrome)/.test(args) ||
    // LL-056 ext: user-local cached Chromium (rod / puppeteer / playwright auto-downloads)
    /^\/\S*\/Chromium\.app\/Contents\/MacOS\/Chromium(?:\s|$)/.test(args) ||
    // LL-056 ext (Linux): Playwright/Puppeteer/Rod cache Chromium in chrome-linux[64]/ subdir
    /^\/\S*\/chrome-linux(?:64)?\/(?:chrome|headless_shell)(?:\s|$)/.test(args) ||
    // LL-056 ext: Playwright/Puppeteer cached headless-shell builds live in chrome-headless-shell-* dir
    /^\/\S*\/chrome-headless-shell(?:\s|$)/.test(args) ||
    // LL-056 ext: cached macOS Chromium helper processes (Renderer/GPU/Network/Plugin).
    // Scoped to binary-path prefix so prompt text can't false-match.
    /\/Chromium\.app\/Contents\/Frameworks\//.test(binaryPath)
  );
}

function parseElapsedSeconds(etime: string | undefined): number | undefined {
  if (!etime) return undefined;
  const [dayPart, timePart] = etime.includes('-') ? etime.split('-', 2) : ['0', etime];
  const days = Number.parseInt(dayPart, 10);
  const parts = timePart.split(':').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(days)) return undefined;
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return days * 24 * 60 * 60 + minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return days * 24 * 60 * 60 + hours * 60 * 60 + minutes * 60 + seconds;
  }
  return undefined;
}

function parseProcessLine(line: string): ProcessEntry | null {
  const m = line.trim().match(/^(\d+)\s+(\d+)(?:\s+([0-9:-]+))?\s+(.+)$/);
  if (!m) return null;
  const ppid = Number.parseInt(m[1], 10);
  const pid = Number.parseInt(m[2], 10);
  const args = m[4];
  if (!Number.isFinite(ppid)) return null;
  if (!Number.isFinite(pid)) return null;
  if (!isChromeBinary(args)) return null;
  const userDataDir = parseAgentBrowserUserDataDir(args);
  if (!userDataDir) return null;
  return {
    ppid,
    pid,
    elapsedSeconds: parseElapsedSeconds(m[3]),
    userDataDir,
  };
}

function parseAgentBrowserUserDataDir(args: string): string | null {
  const m = args.match(USER_DATA_DIR_RE);
  let userDataDir: string | undefined;
  if (m?.[1] !== undefined) {
    userDataDir = m[1];
  } else if (m?.[2] !== undefined) {
    userDataDir = m[2];
  } else if (m?.[3] !== undefined) {
    userDataDir = m[3];
  }
  if (userDataDir === undefined) return null;
  if (!TRACKED_USER_DATA_DIR_OWNERS.some((owner) => userDataDir.includes(owner))) return null;
  return userDataDir;
}

export function parseAgentBrowserChromeCleanupPids(
  psOutput: string,
  ownPid: number,
  staleAfterSeconds = STALE_AGENT_BROWSER_CHROME_SECONDS,
): number[] {
  const entries = psOutput
    .split('\n')
    .map(parseProcessLine)
    .filter((entry): entry is ProcessEntry => entry !== null && entry.pid !== ownPid);
  const cleanupPids = new Set<number>();
  const entriesByUserDataDir = new Map<string, ProcessEntry[]>();

  for (const entry of entries) {
    if (entry.ppid === 1) {
      cleanupPids.add(entry.pid);
    }
    let profileEntries = entriesByUserDataDir.get(entry.userDataDir);
    if (profileEntries === undefined) {
      profileEntries = [];
      entriesByUserDataDir.set(entry.userDataDir, profileEntries);
    }
    profileEntries.push(entry);
  }

  for (const profileEntries of entriesByUserDataDir.values()) {
    const hasStaleNonOrphan = profileEntries.some(
      (entry) => entry.ppid !== 1 && entry.elapsedSeconds !== undefined && entry.elapsedSeconds >= staleAfterSeconds,
    );
    if (!hasStaleNonOrphan) continue;
    for (const entry of profileEntries) {
      cleanupPids.add(entry.pid);
    }
  }

  const result: number[] = [];
  const seen = new Set<number>();
  for (const entry of entries) {
    if (!cleanupPids.has(entry.pid)) continue;
    if (seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    result.push(entry.pid);
  }
  return result;
}

export function parseOrphanPids(psOutput: string, ownPid: number): number[] {
  return parseAgentBrowserChromeCleanupPids(psOutput, ownPid, Number.POSITIVE_INFINITY);
}

const defaultDeps: OrphanChromeDeps = {
  async listProcesses() {
    const { stdout } = await execFileAsync('ps', ['-eo', 'ppid=,pid=,etime=,args='], {
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
    pids = parseAgentBrowserChromeCleanupPids(psOutput, process.pid);
  } catch (err) {
    log.warn(`[orphan-chrome] Failed to list processes: ${String(err)}`);
    return { found: 0, killed: 0, failedPids: [], durationMs: Date.now() - start };
  }

  if (pids.length === 0) {
    return { found: 0, killed: 0, failedPids: [], durationMs: Date.now() - start };
  }

  log.info(`[orphan-chrome] Found ${pids.length} orphan/stale agent-browser Chrome process(es): ${pids.join(', ')}`);

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
    log.info(`[orphan-chrome] Killed ${killed}/${pids.length} orphan/stale process(es) in ${durationMs}ms`);
  }
  if (failedPids.length > 0) {
    log.warn(`[orphan-chrome] Failed to kill PIDs: ${failedPids.join(', ')}`);
  }

  return { found: pids.length, killed, failedPids, durationMs };
}
