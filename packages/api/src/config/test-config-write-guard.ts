import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_SANDBOX_ENV = 'CAT_CAFE_TEST_SANDBOX';
const TEST_SANDBOX_ALLOW_UNSAFE_ROOT_ENV = 'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT';
// NOTE: duplicated in scripts/install-auth-config.mjs because that installer helper
// runs outside the TS build output. Keep the two guards in sync.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Defense-in-depth for tests: config writes must never target the live checkout root
 * or the user's HOME unless a test explicitly opts out.
 */
export function assertSafeTestConfigRoot(targetRoot: string, source: string): void {
  if (process.env[TEST_SANDBOX_ENV] !== '1') return;
  if (process.env[TEST_SANDBOX_ALLOW_UNSAFE_ROOT_ENV] === '1') return;

  const resolvedTarget = resolve(targetRoot);
  const resolvedHome = resolve(process.env.CAT_CAFE_TEST_REAL_HOME || homedir());
  const unsafeTargets: string[] = [];
  if (resolvedTarget === REPO_ROOT) unsafeTargets.push(`repo root (${REPO_ROOT})`);
  if (resolvedTarget === resolvedHome) unsafeTargets.push(`HOME (${resolvedHome})`);
  if (unsafeTargets.length === 0) return;

  throw new Error(
    `[test sandbox] Refusing ${source} write/migration against ${unsafeTargets.join(' / ')}. ` +
      'Use a temp project root or explicit CAT_CAFE_GLOBAL_CONFIG_ROOT for isolation.',
  );
}
