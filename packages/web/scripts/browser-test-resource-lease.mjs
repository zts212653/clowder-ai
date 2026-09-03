import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { acquireProcessResourceLease, positiveInteger } from '../../../scripts/lib/process-resource-lease.mjs';

const DEFAULT_LOG_MS = 30_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_WAIT_MS = 30 * 60 * 1_000;

function resolveDefaultLockDir(cwd) {
  const commonGitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  if (!commonGitDir) throw new Error('Unable to resolve the shared Git directory for browser-test coordination');
  return resolve(commonGitDir, 'cat-cafe-browser-tests.lock');
}

export function commandRunsBrowserTests(args) {
  return args.some((arg) => {
    const normalized = arg.replaceAll('\\', '/');
    return normalized.startsWith('test/browser/') || normalized.includes('/test/browser/');
  });
}

export async function acquireBrowserTestResourceLease({ cwd = process.cwd(), env = process.env } = {}) {
  const lockPath = resolve(env.CAT_CAFE_BROWSER_TEST_LOCK_DIR || resolveDefaultLockDir(cwd));
  return acquireProcessResourceLease({
    lockPath,
    cwd,
    label: 'browser-test-lease',
    logMs: positiveInteger(env.CAT_CAFE_BROWSER_TEST_LEASE_LOG_MS, DEFAULT_LOG_MS),
    pollMs: positiveInteger(env.CAT_CAFE_BROWSER_TEST_LEASE_POLL_MS, DEFAULT_POLL_MS),
    waitMs: positiveInteger(env.CAT_CAFE_BROWSER_TEST_LEASE_WAIT_MS, DEFAULT_WAIT_MS),
  });
}
