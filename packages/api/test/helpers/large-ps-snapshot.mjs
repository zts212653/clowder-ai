import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { streamMacProcessEnvironments } from '../../runtime/process-observation/ps-environment-worker.mjs';

const fixturePath = fileURLToPath(import.meta.url);
const pids = Array.from({ length: 600 }, (_, index) => 2_000_000 + index);
const token = 'bounded-snapshot-target';
const ownerId = '12345678-1234-4234-8234-123456789abc';

export function largePsFixture(scenario = {}) {
  return {
    pids,
    targetPid: pids.at(-1),
    token,
    ownerId,
    command(args) {
      return [fixturePath, args[1], JSON.stringify(scenario)];
    },
    execute(file, args, options) {
      if (file !== process.execPath || !args[0].endsWith('/ps-environment-worker.mjs')) {
        throw Object.assign(new Error('unfiltered snapshot exceeds maxBuffer'), { code: 'ENOBUFS' });
      }
      return execFileSync(process.execPath, this.command(args), options);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(process.argv[2]);
  const scenario = JSON.parse(process.argv[3] ?? '{}');
  const padding = 'x'.repeat(scenario.oversizedLine ? 33 * 1024 * 1024 : 64 * 1024);
  const child = new EventEmitter();
  child.pid = 9_999_999;
  let stopped = false;
  // This fake child has no OS process; signals only close these in-memory streams.
  child.kill = () => {
    stopped = true;
    child.stdout.destroy();
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };
  child.stderr = new PassThrough();
  child.stdout = Readable.from(
    (async function* () {
      if (scenario.vanished) return;
      for (const pid of input.pids ?? pids) {
        if (stopped) break;
        if (scenario.failPid === pid) {
          child.stderr.write('SECRET_CANARY diagnostic');
          break;
        }
        const matches = pid === pids.at(-1) || (scenario.matchFirst && pid === pids[0]);
        const marker = `${token}${matches ? '' : '-other'}`;
        const owner = pid === pids[0] ? ` CAT_CAFE_PROCESS_OWNER_ID=${ownerId}` : '';
        yield Buffer.from(
          `${pid} 1 1 Wed Oct 14 18:00:00 2026 node PADDING=${padding} CAT_CAFE_GATE_JOB_TOKEN=${marker}${owner}\n`,
        );
      }
    })(),
  );
  child.stdout.once('end', () => {
    child.stderr.end();
    setImmediate(() => child.emit('close', scenario.failPid || scenario.vanished ? 1 : 0, null));
  });
  process.exitCode = await streamMacProcessEnvironments(input, { spawnImpl: () => child });
}
