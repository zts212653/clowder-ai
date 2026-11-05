import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Production UI + declared HTTP/Socket.IO fixtures only. No Redis, native CLI,
// logged-in profile or installed application is needed or verified by this lane.
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: web, encoding: 'utf8' }).trim();
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'src', 'public', 'next.config.js', 'tailwind.config.ts'], {
  cwd: web,
  stdio: 'pipe',
});
assert.equal(
  (await readFile(path.join(web, '.next/.build-commit'), 'utf8')).trim(),
  source,
  'Rebuild current HEAD first',
);
const evidence = process.env.CAT_CAFE_ONBOARDING_E2E_EVIDENCE;
assert.ok(evidence && path.isAbsolute(evidence), 'Provide an explicit absolute evidence directory');
await mkdir(path.dirname(evidence), { recursive: true });
await mkdir(evidence); // Preserve previous attempts rather than overwriting them.
async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const log = createWriteStream(path.join(evidence, 'next.log'));
const server = spawn(
  process.execPath,
  [path.join(web, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)],
  {
    cwd: web,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', FRONTEND_PORT: String(port) },
  },
);
const serverEnded = new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal })));
server.stdout.pipe(log, { end: false });
server.stderr.pipe(log, { end: false });
let testProcess, output, interrupted;
const forward = (signal) => {
  interrupted = signal;
  testProcess?.kill(signal);
};
const onInterrupt = () => forward('SIGINT');
const onTerminate = () => forward('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
let result = { code: 1, signal: null };
try {
  await writeFile(path.join(evidence, 'owner.json'), JSON.stringify({ source, cwd: web, url, serverPid: server.pid }));
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(interrupted, undefined, 'Interrupted while starting owned production server');
    assert.equal(server.exitCode, null, 'Owned production server exited before ready');
    if (
      await fetch(url, { signal: AbortSignal.timeout(500) })
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      ready = true;
      break;
    }
    await delay(100);
  }
  assert.ok(ready, 'Owned production server became ready');
  testProcess = spawn(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      ...['native-team-setup', 'native-team-setup-edge', 'native-team-setup-recovery'].map(
        (name) => `test/browser/${name}.test.mjs`,
      ),
    ],
    {
      cwd: web,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CAT_CAFE_ONBOARDING_E2E_URL: url },
    },
  );
  output = createWriteStream(path.join(evidence, 'contracts.log'));
  testProcess.stdout.pipe(output, { end: false });
  testProcess.stderr.pipe(output, { end: false });
  testProcess.stdout.pipe(process.stdout);
  testProcess.stderr.pipe(process.stderr);
  result = await new Promise((resolve, reject) => {
    testProcess.once('error', reject);
    testProcess.once('exit', (code, signal) => resolve({ code, signal }));
  });
} finally {
  if (output) await new Promise((resolve) => output.end(resolve));
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  const stopped = await serverEnded;
  await new Promise((resolve) => log.end(resolve));
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  await writeFile(
    path.join(evidence, 'receipt.json'),
    JSON.stringify(
      {
        source,
        url,
        ...result,
        serverPid: server.pid,
        stopped,
        modelCalls: 0,
        httpBoundaryFixtures: true,
        installedAcceptance: false,
      },
      null,
      2,
    ),
  );
}
process.exitCode = result.code ?? 1;
