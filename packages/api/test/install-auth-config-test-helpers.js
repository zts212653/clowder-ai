import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(testDir, '..', '..', '..');
const helperScript = resolve(repoRoot, 'scripts', 'install-auth-config.mjs');

/** Extract --project-dir from args to use as global config root for test isolation. */
function extractProjectDir(args) {
  const idx = args.indexOf('--project-dir');
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/**
 * Build env overrides: isolate both global root and HOME to prevent homedir
 * migration leaks.
 *
 * CAT_CAFE_TEST_SANDBOX_ROOT is the installer's fail-closed boundary (P1-6).
 * These helpers already know exactly which dir the test owns, so declaring it
 * here covers every suite in one place — and any installer invocation that
 * forgets to declare one is refused rather than silently writing outward.
 * Do NOT swap this for CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT: that switches
 * the whole boundary off instead of naming the sandbox.
 */
/**
 * P1-13: make USERPROFILE follow whatever HOME ENDED UP being.
 *
 * os.homedir() resolves from USERPROFILE on Windows and from HOME elsewhere,
 * and the installer calls it directly in migrateAllLegacySources() — the target
 * sandbox declaration says nothing about where legacy SOURCES are read from. So
 * a child that gets an isolated HOME and an inherited USERPROFILE would, on
 * Windows, take the operator's real profile as a migration source.
 *
 * This has to run AFTER the merge, not as another key inside it: the existing
 * `runHelperWithEnv(args, { HOME: fakeHome })` call shape overrides HOME last,
 * so a `USERPROFILE: projectDir` written before the spread would leave the two
 * coordinates pointing at different directories — isolated, but not at the same
 * place, which is its own bug. A caller that names USERPROFILE explicitly keeps
 * its choice.
 */
function alignHomeCoordinates(env, extraEnv) {
  if (extraEnv && 'USERPROFILE' in extraEnv) return env;
  if (env.HOME === undefined) return env;
  return { ...env, USERPROFILE: env.HOME };
}

export function isolatedEnv(projectDir, extraEnv) {
  return alignHomeCoordinates(
    {
      ...process.env,
      ...(projectDir
        ? { CAT_CAFE_GLOBAL_CONFIG_ROOT: projectDir, HOME: projectDir, CAT_CAFE_TEST_SANDBOX_ROOT: projectDir }
        : {}),
      ...extraEnv,
    },
    extraEnv,
  );
}

export function runHelper(args) {
  const projectDir = extractProjectDir(args);
  return execFileSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: isolatedEnv(projectDir),
  });
}

export function runHelperResult(args) {
  const projectDir = extractProjectDir(args);
  return spawnSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: isolatedEnv(projectDir),
  });
}

export function runHelperWithEnv(args, env) {
  const projectDir = extractProjectDir(args);
  return execFileSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: isolatedEnv(projectDir, env),
  });
}

/**
 * Env for a run WITHOUT CAT_CAFE_GLOBAL_CONFIG_ROOT.
 *
 * P1-13: same both-coordinates rule as isolatedEnv(). Dropping the global
 * override is about which STORE is written; it does not make the operator's
 * profile an acceptable legacy migration source.
 */
export function noGlobalOverrideEnv(projectDir) {
  const { CAT_CAFE_GLOBAL_CONFIG_ROOT: _stripped, ...cleanEnv } = process.env;
  return alignHomeCoordinates(
    {
      ...cleanEnv,
      ...(projectDir ? { HOME: projectDir, CAT_CAFE_TEST_SANDBOX_ROOT: projectDir } : {}),
    },
    undefined,
  );
}

/** Run installer WITHOUT CAT_CAFE_GLOBAL_CONFIG_ROOT — exercises _activeProjectDir fallback. */
export function runHelperNoGlobalOverride(args) {
  const projectDir = extractProjectDir(args);
  return spawnSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: noGlobalOverrideEnv(projectDir),
  });
}
