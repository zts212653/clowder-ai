#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const registryDirectory = process.env.CLAUDE_CONFIG_DIR ?? process.env.FAKE_CLAUDE_BG_REGISTRY;

if (!registryDirectory) process.exit(64);
mkdirSync(registryDirectory, { recursive: true });

if (args[0] === 'stop') {
  const shortId = args[1];
  if (!shortId) process.exit(64);
  writeFileSync(join(registryDirectory, `stop-attempt-${shortId}.json`), `${JSON.stringify({ shortId })}\n`);
  if (existsSync(join(registryDirectory, 'stop-fail'))) process.exit(1);
  const recordPath = join(registryDirectory, `${shortId}.json`);
  try {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    process.kill(record.workerPid, 'SIGTERM');
    unlinkSync(recordPath);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

if (!args.includes('--bg')) process.exit(64);
const shortId = process.env.FAKE_CLAUDE_BG_ID;
if (!shortId) process.exit(64);

if (process.env.FAKE_CLAUDE_BG_DAEMON_SHAPED === '1') {
  const daemonRecordPath = join(registryDirectory, 'daemon.json');
  let daemonAlive = false;
  try {
    const { daemonPid } = JSON.parse(readFileSync(daemonRecordPath, 'utf8'));
    process.kill(daemonPid, 0);
    daemonAlive = true;
  } catch {
    daemonAlive = false;
  }
  if (!daemonAlive) {
    const daemon = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},60000)'],
      {
        detached: true,
        env: {},
        stdio: 'ignore',
      },
    );
    daemon.unref();
    writeFileSync(daemonRecordPath, `${JSON.stringify({ daemonPid: daemon.pid })}\n`);
  }
}

const worker = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},60000)'], {
  detached: true,
  // Agent View jobs do not inherit arbitrary dispatcher env. In particular,
  // CAT_CAFE_PROCESS_OWNER_ID is not a per-job worker identity.
  env: {},
  stdio: 'ignore',
});
worker.unref();
writeFileSync(join(registryDirectory, `${shortId}.json`), `${JSON.stringify({ workerPid: worker.pid })}\n`);
process.stdout.write(
  process.env.FAKE_CLAUDE_BG_BAD_OUTPUT === '1' ? 'dispatcher output unavailable\n' : `backgrounded · ${shortId}\n`,
);
