import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { join } from 'node:path';

export async function holdLock(t, root, durationMs) {
  const child = fork(
    new URL('./managed-job-lock-holder.mjs', import.meta.url),
    [join(root, 'managed-jobs/supervisor.sqlite'), String(durationMs)],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(5000) }),
    closed.then(([code, signal]) => {
      throw new Error(`lock holder exited before ready: ${code}/${signal}: ${stderr}`);
    }),
  ]);
  return {
    closed,
    async release() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
  };
}

export async function healthRequest(t) {
  const server = createServer((_req, res) => res.end('ready'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const started = performance.now();
  return {
    response: new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${server.address().port}`, (res) => {
        res.resume();
        res.once('end', () => resolve(performance.now() - started));
      }).once('error', reject);
    }),
  };
}
