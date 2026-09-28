#!/usr/bin/env node

import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/run-preserving-signal-exit.mjs <cmd> [...args]');
  process.exit(64);
}

const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
let forwardedSignal = null;

const child = spawn(command, args, {
  env: process.env,
  stdio: 'inherit',
  // Windows cannot execute the `.cmd` shims that pnpm installs into
  // node_modules/.bin without a shell, so `next build` failed with
  // "spawn next ENOENT" and the Web build — and therefore the desktop
  // installer — could not run there at all. POSIX keeps shell:false so the
  // arguments are passed literally.
  shell: process.platform === 'win32',
});

for (const signal of Object.keys(signalExitCodes)) {
  process.on(signal, () => {
    forwardedSignal = signal;
    console.error(`[signal-exit] forwarding ${signal} to ${command}; preserving ${signalExitCodes[signal]}`);
    child.kill(signal);
  });
}

child.once('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  if (forwardedSignal) process.exit(signalExitCodes[forwardedSignal]);
  if (signal) process.exit(signalExitCodes[signal] ?? 1);
  process.exit(code ?? 1);
});
