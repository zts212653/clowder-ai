#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { WEB_BUILD_INPUTS, inspectWebBuildInputState } = require('./web-build-input-state.cjs');

const WEB_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');

function run(command, args, { cwd = REPO_ROOT, stdio = 'inherit' } = {}) {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: 'utf8', stdio });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.signal
        ? `${command} ${args.join(' ')} terminated by ${result.signal}`
        : `${command} ${args.join(' ')} exited ${result.status}`,
    );
  }
  return result.stdout?.trim() ?? '';
}

function inspectWebProductionBuild({ webRoot = WEB_ROOT, head, dirtyInputs }) {
  const buildIdPath = path.join(webRoot, '.next', 'BUILD_ID');
  if (!existsSync(buildIdPath)) return { fresh: false, reason: 'missing .next/BUILD_ID' };
  if (!head) return { fresh: false, reason: 'Git HEAD is unavailable' };
  if (dirtyInputs) return { fresh: false, reason: 'Web build inputs have uncommitted changes' };

  const stampPath = path.join(webRoot, '.next', '.build-commit');
  if (!existsSync(stampPath)) return { fresh: false, reason: 'missing .next/.build-commit' };
  if (readFileSync(stampPath, 'utf8').trim() !== head) {
    return { fresh: false, reason: 'Web build revision does not match HEAD' };
  }
  return { fresh: true, reason: 'Web production build matches the clean HEAD' };
}

function currentHead(repoRoot = REPO_ROOT) {
  try {
    return run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' });
  } catch {
    return null;
  }
}

function hasDirtyWebBuildInputs(repoRoot = REPO_ROOT) {
  return inspectWebBuildInputState(repoRoot) !== 'clean';
}

function ensureBrowserTestArtifacts() {
  const webBuild = inspectWebProductionBuild({
    head: currentHead(),
    dirtyInputs: hasDirtyWebBuildInputs(),
  });

  // The F290 journey imports the compiled Service before the test body runs.
  // Build it on every standalone browser lane: unlike Web, this package has no
  // revision stamp that could honestly prove an existing dist belongs to HEAD.
  console.log('[browser-test] building the Collective Service artifact');
  run('pnpm', ['--filter', '@cat-cafe/collective-service', 'build']);

  if (webBuild.fresh) {
    console.log(`[browser-test] reusing Web production artifact: ${webBuild.reason}`);
    return;
  }

  console.log(`[browser-test] building Web production artifact: ${webBuild.reason}`);
  run('pnpm', ['--filter', '@cat-cafe/web', 'build']);
}

module.exports = { WEB_BUILD_INPUTS, ensureBrowserTestArtifacts, inspectWebProductionBuild };

if (require.main === module) {
  try {
    ensureBrowserTestArtifacts();
  } catch (error) {
    console.error(
      `[browser-test] artifact preparation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
