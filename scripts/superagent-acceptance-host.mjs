import { spawn } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceEnvironment } from './superagent-acceptance-env.mjs';

// A real feature Host with its own persistent HOME/config/native state and Redis.
// Optional authentication reuse copies only auth.json into private native state; no model is started here.
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(workspace, 'artifacts', 'superagent-live');
const [redisBinary, authMode] = process.argv.slice(2);
if (!redisBinary || process.platform !== 'win32') throw new Error('Supply the Windows Redis executable path');
const available = (port) =>
  new Promise((resolveAvailable) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveAvailable(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolveAvailable(true);
    });
  });
if (!(await available(3219)) || !(await available(6427))) throw new Error('Acceptance ports are already owned');
const home = join(root, 'home');
const config = join(root, 'config');
const data = join(root, 'data');
const redisData = join(root, 'redis');
await Promise.all([home, config, data, redisData].map((path) => mkdir(path, { recursive: true })));
await copyFile(join(workspace, 'cat-template.json'), join(config, 'cat-template.json'));
const reuseAuth = authMode === '--reuse-codex-auth';
if (reuseAuth) {
  await mkdir(join(home, '.codex'), { recursive: true });
  await copyFile(join(process.env.CODEX_HOME, 'auth.json'), join(home, '.codex/auth.json'));
}
const redis = spawn(redisBinary, ['--bind', '127.0.0.1', '--port', '6427', '--dir', redisData, '--appendonly', 'yes'], {
  windowsHide: true,
  stdio: 'inherit',
});
await new Promise((resolveReady, reject) => {
  redis.once('error', reject);
  redis.stdout?.once('data', resolveReady);
  const check = async () => {
    if (!(await available(6427))) return resolveReady();
    if (redis.exitCode !== null) return reject(new Error('Acceptance Redis exited'));
    setTimeout(check, 100);
  };
  void check();
});
const env = acceptanceEnvironment(process.env, workspace, root);
await new Promise((resolveBootstrap, reject) => {
  const bootstrap = spawn(process.execPath, ['scripts/superagent-acceptance-bootstrap.mjs'], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: 'inherit',
  });
  bootstrap.once('error', reject);
  bootstrap.once('close', (code) =>
    code === 0 ? resolveBootstrap() : reject(new Error('Acceptance capability bootstrap failed')),
  );
});
const api = spawn(process.execPath, ['dist/index.js'], {
  cwd: join(workspace, 'packages/api'),
  env,
  windowsHide: true,
  stdio: 'inherit',
});
await writeFile(
  join(root, 'instance.json'),
  JSON.stringify(
    {
      owner: 'codex',
      taskId: '0001793720663272-000609-8bfe63c4',
      workspace,
      purpose: 'Superagent real Host/browser/native acceptance',
      root,
      home,
      config,
      data,
      redisData,
      apiPort: 3219,
      webPort: 5220,
      redisPort: 6427,
      apiPid: api.pid,
      redisPid: redis.pid,
      accountCopied: reuseAuth,
      evidenceDb: env.EVIDENCE_DB,
      eventMemoryDb: env.EVENT_MEMORY_DB,
      retained: true,
    },
    null,
    2,
  ),
);
const stop = () => {
  api.kill('SIGTERM');
  const cli = spawn(join(dirname(redisBinary), 'redis-cli.exe'), ['-h', '127.0.0.1', '-p', '6427', 'shutdown'], {
    windowsHide: true,
    stdio: 'inherit',
  });
  cli.once('close', () => process.exit());
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
api.once('error', (error) => {
  console.error(error.message);
  stop();
});
api.once('close', (code) => {
  process.exitCode = code ?? 1;
  stop();
});
