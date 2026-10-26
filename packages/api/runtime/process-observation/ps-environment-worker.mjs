import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { macProcessEnvironmentCommand } from './ps-environment-snapshot.mjs';

const MAX_LINE_BYTES = 32 * 1024 * 1024;
const IDENTITY = /^\s*(\d+)\s+\d+\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+(?=\s|$)/u;

export async function streamMacProcessEnvironments(
  { pids, markers, retainEnvironmentKeys = [] },
  { spawnImpl = spawn, output = process.stdout } = {},
) {
  macProcessEnvironmentCommand({ pids, markers, retainEnvironmentKeys });
  if (pids !== undefined && (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))) {
    throw new Error('Invalid process selection');
  }
  if (pids?.length === 0) return 0;
  const selection = pids ? ['-p', pids.join(',')] : ['-ax'];
  const child = spawnImpl('/bin/ps', ['eww', ...selection, '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const decoder = new StringDecoder('utf8');
  const patterns = markers.map(
    (marker) => new RegExp(`(?:^|\\s)${marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\s|$)`, 'u'),
  );
  const retainedPatterns = retainEnvironmentKeys.map((key) => new RegExp(`(?:^|\\s)(${key}=\\S+)(?=\\s|$)`, 'gu'));
  let pending = [];
  let pendingBytes = 0;
  let failed = false;
  let diagnostic = false;
  let sawData = false;
  let forceTimer;
  const stop = () => {
    failed = true;
    child.kill('SIGTERM');
    forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 50);
    forceTimer.unref();
  };
  const consume = (line) => {
    if (!line.trim()) return;
    const identity = IDENTITY.exec(line);
    if (!identity) {
      stop();
      return;
    }
    const pid = Number(identity[1]);
    const keep = pid !== process.pid && pid !== child.pid && patterns.some((pattern) => pattern.test(line));
    const retained = retainedPatterns.flatMap((pattern) => [...line.matchAll(pattern)].map((match) => match[1]));
    if (!output.write(`${keep ? line : [identity[0], ...retained].join(' ')}\n`)) {
      child.stdout.pause();
      output.once('drain', () => child.stdout.resume());
    }
  };
  const accept = (text) => {
    let start = 0;
    while (start < text.length && !failed) {
      const newline = text.indexOf('\n', start);
      const part = text.slice(start, newline < 0 ? undefined : newline);
      pendingBytes += Buffer.byteLength(part);
      if (pendingBytes > MAX_LINE_BYTES) {
        stop();
        return;
      }
      pending.push(part);
      if (newline < 0) return;
      consume(pending.join(''));
      pending = [];
      pendingBytes = 0;
      start = newline + 1;
    }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  output.on('error', stop);
  return new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      sawData ||= chunk.length > 0;
      if (!failed) accept(decoder.write(chunk));
    });
    child.stderr.on('data', (chunk) => {
      diagnostic ||= chunk.toString('utf8').trim().length > 0;
    });
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (code, signal) => {
      if (!failed) {
        accept(decoder.end());
        if (pending.length && !failed) consume(pending.join(''));
      }
      clearTimeout(forceTimer);
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      output.off('error', stop);
      // Vanished exact selections are empty only without bytes, diagnostics,
      // signals or errors. Partial/error results never constitute a snapshot.
      const emptyExact = pids !== undefined && code === 1 && !sawData && !diagnostic && !signal;
      resolve(!failed && !diagnostic && (code === 0 || emptyExact) ? 0 : 70);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await streamMacProcessEnvironments(JSON.parse(process.argv[2]));
  } catch {
    process.exitCode = 70;
  }
}
