import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_FSEVENTSD_RSS_MAX_KB = 4 * 1024 * 1024;
// 6398=worktree dev / 6399=runtime sanctuary / 6401=user-redis persistent user data.
// 6401 must be protected too — flagging it as a killable orphan led to it being murdered
// alongside 6399 (CAFE-INCIDENT-20260527).
const PROTECTED_REDIS_PORTS = new Set([6398, 6399, 6401]);
const ALLOWED_LOCAL_REDIS_PORTS = new Set([6379, ...PROTECTED_REDIS_PORTS]);
// Concurrent-gate detection — another gate / pre-merge-check is already running.
// Downgraded from hard-block to soft-warning (#1912 added this hard-block): gates run in
// parallel safely — no shared writable state (git objects immutable, pnpm store
// writes are atomic hard-links, node_modules/dist/.next are per-worktree), and
// resource pressure has its own independent valves (fseventsd RSS + redis orphan
// checks below). The old hard-block was incident-era over-defense that mis-killed
// legitimate multi-cat concurrency with zero independent protection value.
const CONCURRENT_GATE_PATTERNS = [/pnpm\s+gate\b/, /pre-merge-check\.sh\b/];

// Soft warning — resource-intensive but no data conflict with gate.
// Printed as warning but does NOT block gate from starting.
const SOFT_WARNING_PATTERNS = [/start-dev-profile-isolation\.test\.mjs\b/, /sync-to-opensource\.sh\b/];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${key}`);
    }
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function readFixtureOrCommand(envKey, command, args) {
  const fixture = process.env[envKey];
  if (fixture) {
    return readFileSync(fixture, 'utf8');
  }
  try {
    return execFileSync(command, args, { encoding: 'utf8' });
  } catch (error) {
    return String(error.stdout ?? '');
  }
}

function readProcessRows() {
  const text = readFixtureOrCommand('CAT_CAFE_GATE_GUARD_PS_FIXTURE', 'ps', ['-axo', 'pid=,ppid=,rss=,command=']);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssKb: Number(match[3]),
        command: match[4],
      };
    })
    .filter(Boolean);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readMetadata(lockDir) {
  try {
    return JSON.parse(readFileSync(path.join(lockDir, 'metadata.json'), 'utf8'));
  } catch {
    return {};
  }
}

function holderIgnoreSet(rows, holderPid) {
  const ignored = new Set([process.pid, process.ppid, holderPid].filter(Boolean));
  const parentByPid = new Map(rows.map((row) => [row.pid, row.ppid]));
  let current = holderPid;
  for (let i = 0; i < 12; i += 1) {
    const parent = parentByPid.get(current);
    if (!parent || ignored.has(parent)) {
      break;
    }
    ignored.add(parent);
    current = parent;
  }
  return ignored;
}

function findFseventsdPressure(rows, maxRssKb) {
  return rows.filter((row) => /(^|\/)fseventsd(\s|$)/.test(row.command)).filter((row) => row.rssKb > maxRssKb);
}

function readRedisListeners() {
  const text = readFixtureOrCommand('CAT_CAFE_GATE_GUARD_LSOF_FIXTURE', 'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^redis/.test(line))
    .map((line) => {
      const portMatch = line.match(/(?:127\.0\.0\.1|\*):(\d+)\s+\(LISTEN\)/);
      if (!portMatch) {
        return null;
      }
      // lsof format: COMMAND PID USER ...
      const pidMatch = line.match(/^redis\S*\s+(\d+)/);
      return { port: Number(portMatch[1]), pid: pidMatch ? Number(pidMatch[1]) : null, line };
    })
    .filter(Boolean);
}

// True ownership proof: query Redis-owned filesystem paths via CONFIG GET.
// Redis 8 can report an empty `dir` while still exposing absolute pidfile/logfile
// paths, so check the whole read-only CONFIG response for known Cat Cafe test
// tempdir prefixes.
function isOwnedTestRedis(port) {
  const text = readFixtureOrCommand('CAT_CAFE_GATE_GUARD_REDIS_CONFIG_FIXTURE', 'redis-cli', [
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    'CONFIG',
    'GET',
    'dir',
    'pidfile',
    'logfile',
  ]);
  return /cat-cafe-(?:redis-test\.|rdb-first-start-)/.test(text);
}

function findRedisOrphans() {
  return readRedisListeners().filter(({ port }) => {
    return port >= 6300 && port <= 65535 && !ALLOWED_LOCAL_REDIS_PORTS.has(port);
  });
}

function findMatchingProcesses(rows, holderPid, patterns) {
  const ignored = holderIgnoreSet(rows, holderPid);
  return rows.filter((row) => {
    if (ignored.has(row.pid)) {
      return false;
    }
    if (/codex exec\b|cli-supervisor\.ts\b/.test(row.command)) {
      return false;
    }
    const commandHead = row.command.slice(0, 500);
    return patterns.some((pattern) => pattern.test(commandHead));
  });
}

function runPressureChecks(holderPid) {
  if (process.env.CAT_CAFE_GATE_GUARD_SKIP_PRESSURE === '1') {
    return { failures: [], warnings: [] };
  }

  const rows = readProcessRows();
  const maxFseventsdRssKb = Number(process.env.CAT_CAFE_FSEVENTSD_RSS_MAX_KB ?? DEFAULT_FSEVENTSD_RSS_MAX_KB);
  const failures = [];
  const warnings = [];

  for (const row of findFseventsdPressure(rows, maxFseventsdRssKb)) {
    failures.push(
      `fseventsd RSS ${row.rssKb}KB exceeds ${maxFseventsdRssKb}KB (pid ${row.pid}); reboot or recover before gate`,
    );
  }

  // Phase 1: clean orphan Redis with TRUE ownership proof.
  // Step 1: find candidates (ppid=1 + redis-server proctitle + non-sanctuary port).
  // Step 2: for each candidate, query read-only CONFIG paths. If dir/pidfile/logfile
  //   matches a known Cat Cafe test tmpdir prefix, it's ours.
  // Step 3: port-based shutdown on OWNED instances only.
  // Non-owned Redis (different datadir) is never touched — fails to manual guidance.
  const orphanRedisPattern = /(?:^|\/)redis-server\s+\S*:(\d{2,5})\b/;
  for (const row of rows) {
    if (row.ppid !== 1) continue;
    const m = row.command.match(orphanRedisPattern);
    if (!m) continue;
    const port = Number(m[1]);
    if (ALLOWED_LOCAL_REDIS_PORTS.has(port) || port < 6300 || port > 65535) continue;
    if (!isOwnedTestRedis(port)) continue;
    spawnSync('redis-cli', ['-h', '127.0.0.1', '-p', String(port), 'shutdown', 'nosave'], {
      timeout: 3000,
      stdio: 'ignore',
    });
  }

  // Phase 2: wait briefly for transient orphans (trap fired, Redis still exiting).
  let orphans = findRedisOrphans();
  if (orphans.length > 0) {
    spawnSync('sleep', ['3'], { stdio: 'ignore' });
    orphans = findRedisOrphans();
  }
  for (const orphan of orphans) {
    failures.push(
      `unmanaged redis-server listener on port ${orphan.port}; ` +
        `clean stale isolated Redis before gate. ` +
        `Use 'kill <PID>' after confirming non-sanctuary, or 'pnpm process:cleanup'. ` +
        `NEVER 'lsof -ti tcp:<range> | kill' — CAFE-INCIDENT-20260527.`,
    );
  }

  for (const row of findMatchingProcesses(rows, holderPid, CONCURRENT_GATE_PATTERNS)) {
    warnings.push(
      `concurrent gate detected: pid ${row.pid} ${row.command}. Gates run in parallel safely ` +
        `(no shared writable state); if gate feels slow, concurrent gates are a likely cause.`,
    );
  }

  for (const row of findMatchingProcesses(rows, holderPid, SOFT_WARNING_PATTERNS)) {
    warnings.push(`concurrent resource-intensive process detected: pid ${row.pid} ${row.command}`);
  }

  return { failures, warnings };
}

function acquire(lockDir, holderPid) {
  mkdirSync(path.dirname(lockDir), { recursive: true });

  if (existsSync(lockDir)) {
    const metadata = readMetadata(lockDir);
    if (isPidAlive(Number(metadata.holderPid))) {
      throw new Error(
        `pre-merge gate already running: pid=${metadata.holderPid} cwd=${metadata.cwd ?? '<unknown>'} startedAt=${
          metadata.startedAt ?? '<unknown>'
        }`,
      );
    }
    rmSync(lockDir, { recursive: true, force: true });
  }

  mkdirSync(lockDir);
  const metadata = {
    holderPid,
    guardPid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    host: os.hostname(),
  };
  writeFileSync(path.join(lockDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const { failures, warnings } = runPressureChecks(holderPid);

  for (const w of warnings) {
    console.warn(`[gate-guard] ⚠️  ${w}`);
  }

  if (failures.length > 0) {
    rmSync(lockDir, { recursive: true, force: true });
    throw new Error(`system pressure preflight failed:\n- ${failures.join('\n- ')}`);
  }

  console.log(`[gate-guard] acquired ${lockDir}`);
}

function release(lockDir, holderPid) {
  if (!existsSync(lockDir)) {
    return;
  }
  const metadata = readMetadata(lockDir);
  if (Number(metadata.holderPid) !== holderPid) {
    return;
  }
  rmSync(lockDir, { recursive: true, force: true });
  console.log(`[gate-guard] released ${lockDir}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lockDir = args['lock-dir'];
  const holderPid = Number(args['holder-pid']);
  if (!args.command || !lockDir || !Number.isInteger(holderPid) || holderPid <= 0) {
    throw new Error('usage: pre-merge-gate-guard.mjs <acquire|release> --lock-dir <dir> --holder-pid <pid>');
  }

  if (args.command === 'acquire') {
    acquire(lockDir, holderPid);
    return;
  }
  if (args.command === 'release') {
    release(lockDir, holderPid);
    return;
  }
  throw new Error(`unknown command: ${args.command}`);
}

try {
  main();
} catch (error) {
  console.error(`[gate-guard] ${error.message}`);
  process.exit(1);
}
