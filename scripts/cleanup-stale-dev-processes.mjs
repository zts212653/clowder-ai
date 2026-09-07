#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { isCatCafeCommand, STALE_DEV_PROCESS_RULES } from './lib/stale-dev-process-rules.mjs';

export {
  matchAgentBrowserMcpWrapper,
  matchPinchtabMcpWrapper,
  matchPlaywrightMcpWrapper,
} from './lib/stale-dev-process-rules.mjs';

const HOUR = 60 * 60;
const KILL_GRACE_MS = 2000;
const MAX_REPORTED_COMMAND_LENGTH = 500;

export function formatCommandForReport(command) {
  return command.length <= MAX_REPORTED_COMMAND_LENGTH
    ? command
    : `${command.slice(0, MAX_REPORTED_COMMAND_LENGTH - 3)}...`;
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
    for (const rule of STALE_DEV_PROCESS_RULES) {
      if (proc.elapsedSeconds < rule.minAgeSeconds) continue;
      if (!rule.match(proc)) continue;
      findings.push({ ...proc, ruleId: rule.id, reason: rule.reason });
      break;
    }
  }
  return findings;
}

export function findLongLivedDevProcesses(processes, { ownPid = process.pid } = {}) {
  return processes
    .filter(
      (proc) =>
        proc.pid !== ownPid &&
        proc.elapsedSeconds !== undefined &&
        proc.elapsedSeconds >= 8 * HOUR &&
        (isCatCafeCommand(proc.command) || /(?:^|\s)--filter(?:=|\s+)@cat-cafe\/web(?:\s|$)/.test(proc.command)) &&
        /(?:^|\s)(?:\S*\/)?next(?:\/dist\/bin\/next)?\s+dev(?:\s|$)/.test(proc.command),
    )
    .map((proc) => ({
      ...proc,
      ruleId: 'long-lived-cat-cafe-next-dev',
      reason: 'long-lived Clowder AI Next dev watcher; inspect managed preview ownership before stopping',
    }));
}

function listProcesses() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,sess=,etime=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function printFindings(findings, advisories = []) {
  if (findings.length === 0) {
    console.log('[stale-dev-processes] no cleanup-safe stale Clowder AI dev processes found');
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
        `cmd=${formatCommandForReport(item.command)}`,
      ].join(' '),
    );
  }
  for (const item of advisories) {
    console.log(
      [
        `[stale-dev-processes] advisory pid=${item.pid}`,
        `ppid=${item.ppid}`,
        `etime=${item.elapsed}`,
        `rss=${item.rssKb}KB`,
        `rule=${item.ruleId}`,
        `reason="${item.reason}"`,
        `cmd=${formatCommandForReport(item.command)}`,
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

function sendSignal(item, signal, killFn) {
  try {
    killFn(item.pid, signal);
    return { status: 'sent' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { status: 'gone' };
    return { status: 'failed', failure: { pid: item.pid, signal, err: error } };
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
    const outcome = sendSignal(item, 'SIGTERM', killFn);
    if (outcome.status === 'sent') {
      sigtermSent++;
      pending.push(item);
    } else if (outcome.status === 'gone') {
      alreadyGone++;
    } else {
      failed.push(outcome.failure);
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
    const outcome = sendSignal(item, 'SIGKILL', killFn);
    if (outcome.status === 'sent') {
      sigkillSent++;
    } else if (outcome.status === 'gone') {
      alreadyGone++;
    } else {
      failed.push(outcome.failure);
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
  const processes = parsePsOutput(psOutput);
  const findings = findStaleDevProcesses(processes);
  const advisories = findLongLivedDevProcesses(processes);
  printFindings(findings, advisories);
  if (run) await killFindings(findings);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
