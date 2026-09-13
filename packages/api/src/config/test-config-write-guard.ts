import { realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_SANDBOX_ENV = 'CAT_CAFE_TEST_SANDBOX';
const TEST_SANDBOX_ALLOW_UNSAFE_ROOT_ENV = 'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT';

/**
 * The PHYSICAL path of `target`: absolute, with every symlink resolved.
 *
 * P1-10: this guard compared `resolve()`d strings, so a symlink pointing at an
 * inherited store root was simply a different string and walked straight
 * through — the installer twin already called realpathSync(), this one did not.
 * A boundary that two names for the same directory can straddle is not a
 * boundary.
 *
 * Plain realpathSync() alone is not enough. Write targets legitimately do not
 * exist yet, and the obvious "realpath threw → fall back to the lexical path"
 * hands the alias back: the missing leaf makes the call fail, and the symlinked
 * PARENT never gets resolved. So walk up to the nearest ancestor that does
 * exist, canonicalise THAT, and re-append the segments that do not exist yet.
 */
function canonicalPath(target: string): string {
  const absolute = resolve(target);
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return pending.length > 0 ? resolve(real, ...pending) : real;
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root and still nothing readable: there is no
      // physical path to learn, so the lexical one is all there is.
      if (parent === current) return absolute;
      pending.unshift(basename(current));
      current = parent;
    }
  }
}

// NOTE: duplicated in scripts/install-auth-config.mjs because that installer helper
// runs outside the TS build output. Keep the two guards in sync.
const REPO_ROOT = canonicalPath(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

/**
 * Store roots inherited from the launching environment, captured at MODULE LOAD
 * — before any test body has had a chance to point them at its own tmpdir.
 *
 * A cat's shell is started by the running API process, which exports these to
 * the real stores. A test that only clears CAT_CAFE_GLOBAL_CONFIG_ROOT still
 * inherits them, and the runtime→workspace migration fires on their presence
 * alone, unrelated to the test's own project dir — so it writes OUTSIDE the
 * fixture and the test's own finally block cannot clean it up (P1-5).
 *
 * Roots a test sets itself are assigned after this module is loaded and are
 * therefore absent here, which is what keeps legitimate split-root fixtures
 * working.
 */
const AMBIENT_ROOT_ENV = ['CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT', 'CAT_CAFE_GLOBAL_CONFIG_ROOT'] as const;
const inheritedStoreRoots: string[] = AMBIENT_ROOT_ENV.map((name) => process.env[name])
  .filter((value): value is string => Boolean(value?.trim()))
  .map((value) => canonicalPath(value));

/**
 * A test process must be recognised WITHOUT the caller opting in: relying on
 * scripts/with-test-home.sh to export CAT_CAFE_TEST_SANDBOX made the boundary
 * fail-OPEN for a bare `node --test`, which is how a real store got written
 * (P1-5). NODE_TEST_CONTEXT is set by the node:test runner itself.
 */
function isTestProcess(): boolean {
  return process.env[TEST_SANDBOX_ENV] === '1' || Boolean(process.env.NODE_TEST_CONTEXT);
}

/**
 * The slice of `node:path` containment depends on. Injectable so the Windows
 * semantics can be asserted from a POSIX box — README lists Windows as a
 * first-class platform, and an untested branch there is how P1-10 happened.
 */
export interface PathFlavor {
  relative(from: string, to: string): string;
  isAbsolute(target: string): boolean;
  readonly sep: string;
}

const nativePathFlavor: PathFlavor = { relative, isAbsolute, sep };

/**
 * Is `target` the same directory as `root`, or somewhere beneath it?
 *
 * P1-10: `target.startsWith(`${root}/`)` was wrong twice over. It hard-coded the
 * POSIX separator, so on Windows EVERY descendant of an inherited store root
 * escaped containment and the guard only ever caught the root itself; and it is
 * a substring test, so `/a/bc` counted as inside `/a/b`. relative() knows both
 * the separator and the drive/UNC rules.
 */
export function isPathAtOrUnder(target: string, root: string, flavor: PathFlavor = nativePathFlavor): boolean {
  if (target === root) return true;
  const rel = flavor.relative(root, target);
  if (rel === '') return true;
  // A different drive or UNC share: relative() hands back an absolute path.
  if (flavor.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${flavor.sep}`);
}

/**
 * Every home that must stay off-limits to a test process.
 *
 * The passwd home is ALWAYS in this set and cannot be removed (P1-7). An
 * earlier version returned CAT_CAFE_TEST_REAL_HOME *instead of* the passwd
 * home, which handed any child process a way to un-protect the operator's real
 * home: point that variable at a fake path and the real home was no longer
 * compared against. CAT_CAFE_TEST_REAL_HOME is a hint about where the caller
 * came from, not the escape hatch — that is
 * CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT — so it may only ADD a protected
 * path. userInfo() reads passwd and, unlike homedir(), ignores $HOME.
 */
function protectedHomes(): string[] {
  const homes: string[] = [];
  try {
    homes.push(userInfo().homedir);
  } catch {
    homes.push(homedir());
  }
  const explicit = process.env.CAT_CAFE_TEST_REAL_HOME;
  if (explicit?.trim()) homes.push(explicit);
  return [...new Set(homes.filter(Boolean).map((home) => canonicalPath(home)))];
}

/** Roots a test process may never touch, whichever way it touches them. */
function unsafeReasons(targetRoot: string): string[] {
  // Physical, not lexical: repo root and HOME stay exact-root comparisons (R11
  // ruling 4 — descendants are not widened), but an ALIAS of that exact root is
  // the same directory and must compare equal (P1-10).
  const resolvedTarget = canonicalPath(targetRoot);
  const reasons: string[] = [];
  if (resolvedTarget === REPO_ROOT) reasons.push(`repo root (${REPO_ROOT})`);
  for (const home of protectedHomes()) {
    if (resolvedTarget === home) reasons.push(`HOME (${home})`);
  }
  for (const inherited of inheritedStoreRoots) {
    if (isPathAtOrUnder(resolvedTarget, inherited)) {
      reasons.push(`store root inherited from the launching process (${inherited})`);
    }
  }
  return reasons;
}

function refuse(targetRoot: string, source: string): void {
  if (!isTestProcess()) return;
  if (process.env[TEST_SANDBOX_ALLOW_UNSAFE_ROOT_ENV] === '1') return;

  const reasons = unsafeReasons(targetRoot);
  if (reasons.length === 0) return;

  throw new Error(
    `[test sandbox] Refusing ${source} against ${reasons.join(' / ')}. ` +
      'Use a temp project root or explicit CAT_CAFE_GLOBAL_CONFIG_ROOT for isolation. ' +
      'Run tests through scripts/with-test-home.sh, which strips inherited runtime/workspace roots.',
  );
}

/**
 * Defense-in-depth for tests: config writes must never target the live checkout
 * root, the user's HOME, or a store root inherited from the launching process,
 * unless a test explicitly opts out.
 */
export function assertSafeTestConfigRoot(targetRoot: string, source: string): void {
  refuse(targetRoot, `${source} write/migration`);
}

/**
 * The same boundary applied to READS (P1-8).
 *
 * Guarding only the writers left a bare `node --test` able to read the
 * operator's real accounts.json / credentials.json out of an inherited store
 * and exit 0: nothing was corrupted, so no write guard ever ran, but the test
 * had still resolved production secrets. "Tests use an isolated store" is a
 * data boundary, not a durability one — a readable credential is the leak.
 * Production (non-test) reads are untouched.
 */
export function assertSafeTestConfigRead(targetRoot: string, source: string): void {
  refuse(targetRoot, `${source} read`);
}
