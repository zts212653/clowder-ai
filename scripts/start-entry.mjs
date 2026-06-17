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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWindowsStatus } from './lib/platform-status.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const IS_WINDOWS = process.platform === 'win32';
const CONNECTOR_AUTOSTART_OVERRIDE_VALUES = new Set(['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off']);

function hasConnectorAutostartOverride(env) {
  const normalized = env.CONNECTOR_GATEWAY_AUTOSTART?.trim().toLowerCase();
  return normalized !== undefined && CONNECTOR_AUTOSTART_OVERRIDE_VALUES.has(normalized);
}

function directConnectorAutostartFailClosed(env) {
  if (hasConnectorAutostartOverride(env)) return env;
  return { ...env, CONNECTOR_GATEWAY_AUTOSTART: '0' };
}

// First positional arg is the mode (start | start:direct | dev:direct | status)
const [mode, ...rest] = process.argv.slice(2);

if (mode === 'status') {
  if (IS_WINDOWS) {
    runWindowsStatus({ projectRoot });
  } else {
    const child = spawn('bash', [resolve(__dirname, 'start-dev.sh'), '--status'], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code ?? 1));
  }
} else if (IS_WINDOWS) {
  // Map Unix-style flags to PowerShell switch params
  const flagMap = { '--debug': '-Debug', '--quick': '-Quick', '--memory': '-Memory', '--dev': '-Dev' };
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(__dirname, 'start-windows.ps1')];
  // dev:direct → pass -Dev to PowerShell
  if (mode === 'dev:direct') psArgs.push('-Dev');
  // Extract --profile=* (not a PS1 param) and pass via env instead
  const profileArg = rest.find((a) => a.startsWith('--profile='));
  const profileName = profileArg?.split('=')[1];
  let childEnv = { ...process.env };
  if (mode === 'start:direct' || mode === 'dev:direct') {
    childEnv = directConnectorAutostartFailClosed(childEnv);
  }
  if (profileName) {
    childEnv.CAT_CAFE_PROFILE = profileName;
    childEnv.CAT_CAFE_STRICT_PROFILE_DEFAULTS = '1';
  }
  for (const arg of rest) {
    if (arg.startsWith('--profile=')) continue;
    const mapped = flagMap[arg];
    psArgs.push(mapped ?? arg);
  }
  const child = spawn('powershell', psArgs, { cwd: projectRoot, stdio: 'inherit', env: childEnv });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  // Unix: dispatch based on mode
  const hasProfile = rest.some((a) => a.startsWith('--profile'));
  let cmd, args, env;
  if (mode === 'start') {
    cmd = resolve(__dirname, 'runtime-worktree.sh');
    args = ['start', ...rest];
    env = { ...process.env };
  } else if (mode === 'start:direct') {
    cmd = resolve(__dirname, 'start-dev.sh');
    args = ['--prod-web', ...rest];
    env = directConnectorAutostartFailClosed({
      ...process.env,
      ...(hasProfile ? { CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1' } : {}),
      CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
      CAT_CAFE_DIRECT_NO_WATCH: '1',
    });
  } else if (mode === 'dev:direct') {
    cmd = resolve(__dirname, 'start-dev.sh');
    args = [...rest];
    env = directConnectorAutostartFailClosed({
      ...process.env,
      ...(hasProfile ? { CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1' } : {}),
      CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
    });
  } else {
    console.error(`Unknown mode: ${mode}. Use: start, start:direct, dev:direct, status`);
    process.exit(1);
  }
  const child = spawn('bash', [cmd, ...args], { cwd: projectRoot, stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 1));
}
