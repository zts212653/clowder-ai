#!/usr/bin/env node
// Regression dry-run for the SIGUSR1 inspector guard (codex/砚砚 blocking finding
// on 0bd7698bf). Proves that with the guard preloaded via NODE_OPTIONS=--import,
// sending SIGUSR1 to the `tsx watch` PARENT process (and its app child) does NOT
// open the V8 inspector — i.e. the guard reaches the watcher process that the
// src/index.ts guard alone cannot.
//
// A negative control (no guard -> inspector DOES open) runs first so a broken
// probe cannot produce a false PASS. Uses a custom --inspect-port to avoid the
// default 9229 (which a `node --test` runner may already hold).
//
// Run: node scripts/verify-sigusr1-guard.mjs   (exit 0 = both cases correct)
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const GUARD = join(HERE, 'sigusr1-guard.mjs');
const TSX = join(HERE, '..', 'node_modules', '.bin', 'tsx');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask the OS for an ephemeral free port (listen on :0, read it back, release).
// Less collision-prone than fixed ports — a concurrent process or `node --test`
// runner cannot false-fail the dry-run by already holding a hardcoded port.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(800, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function waitFor(fn, tries, gapMs) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await sleep(gapMs);
  }
  return false;
}

function children(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function runCase({ guard }) {
  const appPort = await freePort();
  const inspectPort = await freePort();
  const work = mkdtempSync(join(tmpdir(), 'usr1guard-'));
  const app = join(work, 'app.mjs');
  writeFileSync(
    app,
    `import http from 'node:http';\nhttp.createServer((_, r) => r.end('ok')).listen(${appPort}, () => console.log('BOOTED'));\nsetInterval(() => {}, 1000);\n`,
  );
  const nodeOpts = `--inspect-port=${inspectPort}${guard ? ` --import ${GUARD}` : ''}`;
  const child = spawn(TSX, ['watch', app], {
    cwd: work,
    env: { ...process.env, NODE_OPTIONS: nodeOpts },
    stdio: 'ignore',
  });
  let opened = null;
  try {
    if (!(await waitFor(() => probePort(appPort), 80, 250))) throw new Error('app did not boot');
    for (const p of [child.pid, ...children(child.pid)]) {
      try {
        process.kill(Number(p), 'SIGUSR1');
      } catch {
        /* process may already be gone */
      }
    }
    opened = await waitFor(() => probePort(inspectPort), 15, 200);
  } finally {
    for (const p of [...children(child.pid), child.pid]) {
      try {
        process.kill(Number(p), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await waitFor(async () => !(await probePort(inspectPort)), 25, 200);
    rmSync(work, { recursive: true, force: true });
  }
  return opened;
}

const control = await runCase({ guard: false });
const treatment = await runCase({ guard: true });
console.log(`control (no guard):  inspector opened = ${control}  (expect true)`);
console.log(`treatment (guarded): inspector opened = ${treatment}  (expect false)`);

const ok = control === true && treatment === false;
console.log(ok ? 'PASS — guard suppresses SIGUSR1 inspector across the tsx watch tree' : 'FAIL');
process.exit(ok ? 0 : 1);
