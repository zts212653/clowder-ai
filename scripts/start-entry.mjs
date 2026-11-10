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
 * (start-dev.sh, same as start:direct). Release archives, other distributions,
 * explicit runtime settings (runtime options or CAT_CAFE_RUNTIME_* variables) and
 * checkouts that already have a runtime worktree keep the runtime entry; the
 * isolated runtime worktree stays available as `pnpm runtime:start`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWindowsStatus } from './lib/platform-status.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const IS_WINDOWS = process.platform === 'win32';
// First positional arg is the mode (start | start:direct | dev:direct | status)
const [mode, ...rest] = process.argv.slice(2);

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// runtime-worktree.sh settings that start-dev.sh would silently ignore. Its parser
// consumes one leading `--` forwarded by pnpm and hands everything after the next
// `--` to start-dev.sh, so only options before that separator count.
const RUNTIME_OPTIONS = new Set([
  '--dir',
  '--branch',
  '--remote',
  '--expected-target-sha',
  '--sync',
  '--no-sync',
  '--no-install',
  '--force',
  '--help',
  '-h',
]);
const RUNTIME_ENV = ['CAT_CAFE_RUNTIME_DIR', 'CAT_CAFE_RUNTIME_BRANCH', 'CAT_CAFE_RUNTIME_REMOTE'];

function requestsRuntime(args) {
  if (RUNTIME_ENV.some((key) => process.env[key])) return true;
  const options = args[0] === '--' ? args.slice(1) : args;
  for (const arg of options) {
    if (arg === '--') return false;
    if (RUNTIME_OPTIONS.has(arg) || arg.startsWith('--expected-target-sha=')) return true;
  }
  return false;
}

/** Mirrors runtime-worktree.sh worktree_exists for its default RUNTIME_DIR (../cat-cafe-runtime). */
function existingRuntimeWorktree() {
  const runtimeDir = resolve(projectRoot, '..', 'cat-cafe-runtime');
  const target = realpathOrNull(runtimeDir);
  if (!target) return null;
  const listed = spawnSync('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (listed.status !== 0) return null;
  const registered = listed.stdout
    .split('\n')
    .some((line) => line.startsWith('worktree ') && realpathOrNull(line.slice('worktree '.length)) === target);
  return registered ? runtimeDir : null;
}

/**
 * #50: a git clone of the open-source distribution starts from the checkout the
 * user is editing, with their own .env. Mirrors runtime-worktree.sh is_git_repo:
 * only the project's own .git counts, so an archive unpacked inside another
 * checkout keeps the in-place runtime entry. Explicit runtime settings keep
 * runtime-worktree.sh semantics, and a checkout that already has a runtime
 * worktree keeps using it: state written there (members and co-creator profile
 * in .cat-cafe/cat-catalog.json, .env, uploads, data/) must not silently drop out.
 */
function startsInPlaceByDefault(args, { explain = false } = {}) {
  let activeProfile;
  try {
    const profilesPath = resolve(projectRoot, 'packages/shared/src/deployment-profiles.json');
    activeProfile = JSON.parse(readFileSync(profilesPath, 'utf8')).activeProfile;
  } catch {
    return false;
  }
  if (activeProfile !== 'opensource' || !existsSync(resolve(projectRoot, '.git'))) return false;
  if (spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }).status !== 0)
    return false;
  if (requestsRuntime(args)) return false;
  const runtimeDir = existingRuntimeWorktree();
  if (runtimeDir) {
    if (explain) {
      console.error(
        `[start] Keeping the existing runtime worktree ${runtimeDir} so its settings stay in effect. ` +
          'To start this checkout in place instead, run `pnpm start:direct` (see SETUP.md).',
      );
    }
    return false;
  }
  return true;
}

if (mode === 'status') {
  if (IS_WINDOWS) {
    runWindowsStatus({ projectRoot });
  } else {
    let cmd = resolve(__dirname, 'runtime-worktree.sh');
    let args = ['daemon-status'];
    if (startsInPlaceByDefault(rest)) {
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
  if (mode === 'start' && startsInPlaceByDefault(rest, { explain: true })) {
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
