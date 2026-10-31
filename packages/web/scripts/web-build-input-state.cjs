const { execFileSync } = require('node:child_process');
const path = require('node:path');

const WEB_PACKAGE_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEB_PACKAGE_DIR, '../..');
const WEB_BUILD_INPUTS = Object.freeze([
  'packages/web',
  'packages/shared',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]);

function runGit(args, repoRoot) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function inspectWebBuildInputState(repoRoot = REPO_ROOT) {
  try {
    if (runGit(['rev-parse', '--is-inside-work-tree'], repoRoot) !== 'true') return 'non_git';
  } catch {
    return 'non_git';
  }

  try {
    return runGit(['status', '--porcelain', '--untracked-files=all', '--', ...WEB_BUILD_INPUTS], repoRoot)
      ? 'dirty'
      : 'clean';
  } catch {
    return 'unknown';
  }
}

module.exports = {
  REPO_ROOT,
  WEB_BUILD_INPUTS,
  inspectWebBuildInputState,
};
