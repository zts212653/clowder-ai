import { spawn } from 'node:child_process';

const [cmd, ...args] = process.argv.slice(2);

if (!cmd) {
  console.error('Usage: node scripts/run-with-node-env-test.mjs <cmd> [...args]');
  process.exit(1);
}

const child = spawn(cmd, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
