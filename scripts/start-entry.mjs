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
 *
 * On Unix, `start` and `status` in an open-source git checkout run in place
 * (start-dev.sh, same as start:direct). Release archives and other distributions
 * keep the runtime entry; the isolated runtime worktree stays `pnpm runtime:start`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWindowsStatus } from './lib/platform-status.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const IS_WINDOWS = process.platform === 'win32';
// First positional arg is the mode (start | start:direct | dev:direct | status)
const [mode, ...rest] = process.argv.slice(2);

/**
 * #50: a git clone of the open-source distribution starts from the checkout the
 * user is editing, with their own .env. Mirrors runtime-worktree.sh is_git_repo:
 * only the project's own .git counts, so an archive unpacked inside another
 * checkout keeps the in-place runtime entry.
 */
function startsInPlaceByDefault() {
  let activeProfile;
  try {
    const profilesPath = resolve(projectRoot, 'packages/shared/src/deployment-profiles.json');
    activeProfile = JSON.parse(readFileSync(profilesPath, 'utf8')).activeProfile;
  } catch {
    return false;
  }
  if (activeProfile !== 'opensource' || !existsSync(resolve(projectRoot, '.git'))) return false;
  return spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }).status === 0;
}

if (mode === 'status') {
  if (IS_WINDOWS) {
    runWindowsStatus({ projectRoot });
  } else {
    let cmd = resolve(__dirname, 'runtime-worktree.sh');
    let args = ['daemon-status'];
    if (startsInPlaceByDefault()) {
      // Report the daemon `pnpm start` launched in place, the same one `pnpm stop` stops.
      cmd = resolve(__dirname, 'start-dev.sh');
      args = ['--status'];
    }
    const child = spawn('bash', [cmd, ...args], {
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
  const childEnv = { ...process.env };
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
  if (mode === 'start' && startsInPlaceByDefault()) {
    // Same launch as start:direct: the user's checkout and .env, no runtime worktree.
    cmd = resolve(__dirname, 'start-dev.sh');
    args = ['--prod-web', '--profile=opensource', ...rest];
    env = {
      ...process.env,
      CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1',
      CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
      CAT_CAFE_DIRECT_NO_WATCH: '1',
    };
  } else if (mode === 'start') {
    cmd = resolve(__dirname, 'runtime-worktree.sh');
    args = ['start', ...rest];
    env = {
      ...process.env,
      CAT_CAFE_DIRECT_NO_WATCH: '1',
    };
  } else if (mode === 'start:direct') {
    cmd = resolve(__dirname, 'start-dev.sh');
    args = ['--prod-web', ...rest];
    env = {
      ...process.env,
      ...(hasProfile ? { CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1' } : {}),
      CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
      CAT_CAFE_DIRECT_NO_WATCH: '1',
    };
  } else if (mode === 'dev:direct') {
    cmd = resolve(__dirname, 'start-dev.sh');
    args = [...rest];
    env = {
      ...process.env,
      ...(hasProfile ? { CAT_CAFE_STRICT_PROFILE_DEFAULTS: '1' } : {}),
      CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
    };
  } else {
    console.error(`Unknown mode: ${mode}. Use: start, start:direct, dev:direct, status`);
    process.exit(1);
  }
  const child = spawn('bash', [cmd, ...args], { cwd: projectRoot, stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 1));
}
