#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const HOUR = 60 * 60;
const KILL_GRACE_MS = 2000;

// 6379=default / 6099=fork runtime sanctuary / 6398=worktree dev /
// 6399=runtime sanctuary / 6401=user-redis persistent data.
// These are NEVER orphans to clean — excluding them is the primary safety guard for the
// orphan-isolated-redis rule below (CAFE-INCIDENT-20260527).
const PROTECTED_REDIS_PORTS = new Set([6379, 6099, 6398, 6399, 6401]);

const RULES = [
  {
    id: 'orphan-isolated-redis',
    minAgeSeconds: 10 * 60,
    // Unmanaged isolated test Redis reparented to init (parent gate/test died) on a
    // non-sanctuary port. ppid===1 means the parent is gone, so this is a true orphan;
    // the port exclusion guarantees we never touch sanctuary ports.
    match: (p) => {
      if (p.ppid !== 1) return false;
      const m = p.command.match(/(?:^|\/)redis-server\s+\S*:(\d{2,5})\b/);
      if (!m) return false;
      return !PROTECTED_REDIS_PORTS.has(Number(m[1]));
    },
    reason: 'orphaned unmanaged isolated Redis (reparented to init, non-sanctuary port)',
  },
  {
    id: 'cat-cafe-node-test-watch',
    minAgeSeconds: HOUR,
    match: (p) =>
      p.ppid === 1 && p.command.includes('--test-timeout=0') && /test\/cli-spawn-[\w-]+\.test\.js/.test(p.command),
    reason: 'orphaned Node test/watch process',
  },
  {
    id: 'agent-browser-cli',
    minAgeSeconds: HOUR,
    match: (p) => p.ppid === 1 && /\/agent-browser(?:-[\w]+)*$/.test(p.command.trim()),
    reason: 'orphaned agent-browser CLI',
  },
  {
    id: 'catcafe-test-tmux',
    minAgeSeconds: HOUR,
    match: (p) => p.ppid === 1 && /tmux\b.*\bcatcafe-test-agent-spawn-/.test(p.command),
    reason: 'orphaned Clowder AI test tmux session',
  },
  {
    id: 'orphan-alpha-start',
    minAgeSeconds: 12 * HOUR,
    match: (p) => p.ppid === 1 && /\bpnpm\b.*\balpha:start\b/.test(p.command),
    reason: 'orphaned alpha:start process',
  },
  // F247 KD-19: MCP wrapper lifecycle hygiene gate.
  //
  // The npx MCP server wrappers (agent-browser-mcp / @playwright/mcp / pinchtab-mcp)
  // do NOT exit cleanly when their stdio parent dies. Each cat invocation that
  // touches one leaves an `npm exec ...` + `node .../-mcp` pair behind, accumulating
  // across days. See LL-056 (cleanup must group by resource ownership, not just PID)
  // + feedback_agent_browser_zombie (5 reoccurrences).
  //
  // Rules below match by **command structure** (executable + first subcommand),
  // NOT substring search, per codex/砚砚 R1 P1+P2:
  //   - substring `mcp` is unsafe; `pinchtab-darwin-arm64 server --upstream-mcp-config`
  //     would be mis-killed under the R0 draft.
  //   - explicit MCP wrapper match — never matches `node` / `npm` / `playwright` generic
  //   - pinchtab `server` / `bridge` long-lived daemons EXPLICITLY excluded by
  //     subcommand check (server/bridge as first arg → not MCP wrapper, skip)
  //   - 8h age threshold — active cat sessions are < 8h, only stale wrappers caught
  //   - no ppid===1 requirement — wrappers' npm exec parents may still be alive
  //     but the wrapper itself is dead weight (LL-056: parent chain alone isn't
  //     the right ownership model)
  {
    id: 'stale-agent-browser-mcp-wrapper',
    minAgeSeconds: 8 * HOUR,
    match: (p) => matchAgentBrowserMcpWrapper(p.command),
    reason: 'stale agent-browser-mcp wrapper (>8h, unused MCP server lifetime)',
  },
  {
    id: 'stale-playwright-mcp-wrapper',
    minAgeSeconds: 8 * HOUR,
    match: (p) => matchPlaywrightMcpWrapper(p.command),
    reason: 'stale @playwright/mcp wrapper (>8h)',
  },
  {
    id: 'stale-pinchtab-mcp-wrapper',
    minAgeSeconds: 8 * HOUR,
    match: (p) => matchPinchtabMcpWrapper(p.command),
    reason: 'stale pinchtab-mcp wrapper (>8h)',
  },
];

// F247 KD-19 R1: command-structure matchers.
// Each parses the command into [executable, ...args], then checks executable
// basename + first relevant arg. NEVER substring-searches the full command —
// that would mis-flag `pinchtab-darwin-arm64 server --upstream-mcp-config x.json`.

/** Tokenize a `ps` command into whitespace-separated argv parts. */
function tokenizeCommand(command) {
  return command.trim().split(/\s+/);
}

/** Get the final path segment of an executable path or token. */
function execBasename(token) {
  if (!token) return '';
  const idx = token.lastIndexOf('/');
  return idx >= 0 ? token.slice(idx + 1) : token;
}

/** `pinchtab` / `pinchtab-mcp` / `pinchtab-darwin-arm64` / `pinchtab-linux-x64` etc. */
function isPinchtabBinaryBasename(name) {
  return /^pinchtab(?:-[a-z]+(?:-[a-z0-9]+)?)?$/.test(name);
}

/** agent-browser-mcp matcher: `npm exec agent-browser-mcp` OR `node .../agent-browser-mcp`. */
export function matchAgentBrowserMcpWrapper(command) {
  const tokens = tokenizeCommand(command);
  if (tokens.length < 2) return false;
  const [exec, ...rest] = tokens;
  const execBase = execBasename(exec);
  // form 1: `npm exec agent-browser-mcp [args...]`
  if (execBase === 'npm' && rest[0] === 'exec' && rest[1] === 'agent-browser-mcp') return true;
  // form 2: `node /abs/path/.../agent-browser-mcp [args...]`
  if (execBase === 'node' && rest.length >= 1 && execBasename(rest[0]) === 'agent-browser-mcp') return true;
  return false;
}

/** @playwright/mcp wrapper: `npm exec @playwright/mcp[@version]` OR `node .../playwright-mcp`. */
export function matchPlaywrightMcpWrapper(command) {
  const tokens = tokenizeCommand(command);
  if (tokens.length < 2) return false;
  const [exec, ...rest] = tokens;
  const execBase = execBasename(exec);
  // form 1: `npm exec @playwright/mcp[@version] [args...]`
  if (execBase === 'npm' && rest[0] === 'exec' && /^@playwright\/mcp(?:@\S+)?$/.test(rest[1] ?? '')) return true;
  // form 2: `node /abs/path/.../playwright-mcp [args...]`
  if (execBase === 'node' && rest.length >= 1 && execBasename(rest[0]) === 'playwright-mcp') return true;
  return false;
}

/**
 * Pinchtab MCP wrapper matcher. Three accepted invocation shapes:
 *   1. Direct `pinchtab-mcp` binary — basename is the MCP itself, any args.
 *      e.g. `pinchtab-mcp --port 9090` / `/usr/local/bin/pinchtab-mcp ...`
 *   2. Wrapped via npx / `npm exec` — npx/npm front the binary.
 *      e.g. `npx pinchtab-mcp ...` / `npm exec pinchtab-mcp ...`
 *   3. Subcommand form on platform-tagged binary — `<pinchtab-XXX> mcp [args]`.
 *      e.g. `pinchtab-darwin-arm64 mcp` / `/home/user/pinchtab mcp`.
 *      First sub-arg MUST be exactly `mcp`. `server` / `bridge` / anything else
 *      is rejected (the long-lived non-MCP daemons of PinchTab).
 */
export function matchPinchtabMcpWrapper(command) {
  const tokens = tokenizeCommand(command);
  if (tokens.length < 1) return false;
  const [exec, ...rest] = tokens;
  const execBase = execBasename(exec);

  // form 1: direct `pinchtab-mcp` binary — name IS the MCP wrapper.
  if (execBase === 'pinchtab-mcp') return true;

  // form 2: npx / npm exec wrappers around the binary.
  if (execBase === 'npx' && rest[0] === 'pinchtab-mcp') return true;
  if (execBase === 'npm' && rest[0] === 'exec' && rest[1] === 'pinchtab-mcp') return true;

  // form 3: platform-tagged binary with `mcp` subcommand. Excludes `pinchtab-mcp`
  // here since form 1 already handled that direct-binary case.
  if (isPinchtabBinaryBasename(execBase) && execBase !== 'pinchtab-mcp') {
    return rest[0] === 'mcp';
  }

  return false;
}

export function parseElapsedSeconds(raw) {
  const value = raw.trim();
  const [dayPart, timePart] = value.includes('-') ? value.split('-', 2) : ['0', value];
  const days = Number.parseInt(dayPart, 10);
  const parts = timePart.split(':').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(days) || parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return days * 86400 + minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }
  return undefined;
}

export function parsePsOutput(psOutput) {
  return psOutput
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      const [, pid, ppid, pgid, sess, etime, rss, command] = match;
      return {
        pid: Number.parseInt(pid, 10),
        ppid: Number.parseInt(ppid, 10),
        pgid: Number.parseInt(pgid, 10),
        sess: Number.parseInt(sess, 10),
        elapsed: etime,
        elapsedSeconds: parseElapsedSeconds(etime),
        rssKb: Number.parseInt(rss, 10),
        command,
      };
    })
    .filter(Boolean);
}

export function findStaleDevProcesses(processes, { ownPid = process.pid } = {}) {
  const findings = [];
  for (const proc of processes) {
    if (proc.pid === ownPid) continue;
    if (proc.elapsedSeconds === undefined) continue;
    for (const rule of RULES) {
      if (proc.elapsedSeconds < rule.minAgeSeconds) continue;
      if (!rule.match(proc)) continue;
      findings.push({ ...proc, ruleId: rule.id, reason: rule.reason });
      break;
    }
  }
  return findings;
}

function listProcesses() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,sess=,etime=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function printFindings(findings) {
  if (findings.length === 0) {
    console.log('[stale-dev-processes] no stale Clowder AI dev processes found');
    return;
  }
  for (const item of findings) {
    console.log(
      [
        `[stale-dev-processes] pid=${item.pid}`,
        `ppid=${item.ppid}`,
        `etime=${item.elapsed}`,
        `rss=${item.rssKb}KB`,
        `rule=${item.ruleId}`,
        `reason="${item.reason}"`,
        `cmd=${item.command}`,
      ].join(' '),
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

export async function terminateFindings(
  findings,
  { killFn = process.kill.bind(process), existsFn = processExists, sleepFn = sleep, graceMs = KILL_GRACE_MS } = {},
) {
  let sigtermSent = 0;
  let sigkillSent = 0;
  let alreadyGone = 0;
  const failed = [];
  const pending = [];

  for (const item of findings) {
    try {
      killFn(item.pid, 'SIGTERM');
      sigtermSent++;
      pending.push(item);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') {
        alreadyGone++;
      } else {
        failed.push({ pid: item.pid, signal: 'SIGTERM', err });
      }
    }
  }

  if (pending.length > 0) {
    await sleepFn(graceMs);
  }

  for (const item of pending) {
    if (!existsFn(item.pid)) {
      alreadyGone++;
      continue;
    }
    try {
      killFn(item.pid, 'SIGKILL');
      sigkillSent++;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') {
        alreadyGone++;
      } else {
        failed.push({ pid: item.pid, signal: 'SIGKILL', err });
      }
    }
  }

  return { sigtermSent, sigkillSent, alreadyGone, failed };
}

async function killFindings(findings) {
  const result = await terminateFindings(findings);
  console.log(
    `[stale-dev-processes] sigterm=${result.sigtermSent} sigkill=${result.sigkillSent} gone=${result.alreadyGone} failed=${result.failed.length}`,
  );
  if (result.failed.length > 0) {
    process.exitCode = 1;
    for (const failure of result.failed) {
      console.error(`[stale-dev-processes] failed pid=${failure.pid} signal=${failure.signal}: ${String(failure.err)}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const run = argv.includes('--run');
  const psOutput = listProcesses();
  const findings = findStaleDevProcesses(parsePsOutput(psOutput));
  printFindings(findings);
  if (run) await killFindings(findings);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
