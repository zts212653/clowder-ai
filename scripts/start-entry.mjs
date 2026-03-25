#!/usr/bin/env node
/**
 * Cross-platform start entry point.
 *
 * Dispatches to the platform-native startup script:
 *   Windows → powershell start-windows.ps1
 *   Unix    → bash runtime-worktree.sh / start-dev.sh
 *
 * Usage (via package.json):
 *   pnpm start              → start-entry.mjs start [--debug] [--quick] [--memory]
 *   pnpm start:direct       → start-entry.mjs start:direct [--debug] [--quick] [--memory]
 *   pnpm dev:direct          → start-entry.mjs dev:direct [--debug] [--quick] [--memory]
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const IS_WINDOWS = process.platform === 'win32';

// First positional arg is the mode (start | start:direct | dev:direct)
const [mode, ...rest] = process.argv.slice(2);

if (IS_WINDOWS) {
  // Map Unix-style flags to PowerShell switch params
  const flagMap = { '--debug': '-Debug', '--quick': '-Quick', '--memory': '-Memory', '--dev': '-Dev' };
  const psArgs = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', resolve(__dirname, 'start-windows.ps1'),
  ];
  // dev:direct → pass -Dev to PowerShell
  if (mode === 'dev:direct') psArgs.push('-Dev');
  for (const arg of rest) {
    const mapped = flagMap[arg];
    psArgs.push(mapped ?? arg);
  }
  const child = spawn('powershell', psArgs, { cwd: projectRoot, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  // Unix: dispatch based on mode
  let cmd, args, env;
  if (mode === 'start') {
    cmd = resolve(__dirname, 'runtime-worktree.sh');
    args = ['start', ...rest];
    env = { ...process.env };
  } else if (mode === 'start:direct') {
    cmd = resolve(__dirname, 'start-dev.sh');
    args = ['--prod-web', '--profile=opensource', ...rest];
    env = {
      ...process.env,
      CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1',
      CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
      CAT_CAFE_DIRECT_NO_WATCH: '1',
    };
  } else if (mode === 'dev:direct') {
    cmd = resolve(__dirname, 'start-dev.sh');
    args = ['--profile=opensource', ...rest];
    env = {
      ...process.env,
      CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1',
      CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
    };
  } else {
    console.error(`Unknown mode: ${mode}. Use: start, start:direct, dev:direct`);
    process.exit(1);
  }
  const child = spawn('bash', [cmd, ...args], { cwd: projectRoot, stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 1));
}
