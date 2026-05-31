#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const HOUR = 60 * 60;
const KILL_GRACE_MS = 2000;

// 6379=default / 6398=worktree dev / 6399=runtime sanctuary / 6401=user-redis persistent data.
// These are NEVER orphans to clean — excluding them is the primary safety guard for the
// orphan-isolated-redis rule below (CAFE-INCIDENT-20260527).
const PROTECTED_REDIS_PORTS = new Set([6379, 6398, 6399, 6401]);

const RULES = [
  {
    id: 'orphan-isolated-redis',
    minAgeSeconds: 10 * 60,
    // Unmanaged isolated test Redis reparented to init (parent gate/test died) on a
    // non-sanctuary port. ppid===1 means the parent is gone, so this is a true orphan;
    // the port exclusion guarantees we never touch the 6398/6399/6401 sanctuary.
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
    reason: 'orphaned Cat Cafe test tmux session',
  },
  {
    id: 'orphan-alpha-start',
    minAgeSeconds: 12 * HOUR,
    match: (p) => p.ppid === 1 && /\bpnpm\b.*\balpha:start\b/.test(p.command),
    reason: 'orphaned alpha:start process',
  },
];

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
    console.log('[stale-dev-processes] no stale Cat Cafe dev processes found');
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
