const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Single source of truth for "which commit is this Web bundle?". next.config.js
// embeds the answer into the browser bundle; scripts/write-build-stamp.cjs
// records the same answer on disk for the API to publish. If these two ever
// disagreed, F294's deployment guard would fail closed on a healthy deploy —
// so both must resolve through here rather than keeping parallel copies.
const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/;
const WEB_PACKAGE_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEB_PACKAGE_DIR, '../..');

function normalizeBuildRevision(value) {
  const revision = value?.trim().toLowerCase();
  return revision && FULL_GIT_COMMIT.test(revision) ? revision : null;
}

function resolveWebBuildRevision({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  const explicit = normalizeBuildRevision(env.CAT_CAFE_WEB_BUILD_REVISION);
  if (explicit) return explicit;
  try {
    return normalizeBuildRevision(
      // stderr silenced: a non-git deploy is a supported case, not a build error.
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}

module.exports = {
  FULL_GIT_COMMIT,
  REPO_ROOT,
  WEB_PACKAGE_DIR,
  normalizeBuildRevision,
  resolveWebBuildRevision,
};
