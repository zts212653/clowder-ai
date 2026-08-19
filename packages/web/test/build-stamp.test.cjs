const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { afterEach, describe, it } = require('node:test');

const { buildStampPath, writeBuildStamp, DIST_DIR_NAME, STAMP_FILE_NAME } = require('../scripts/write-build-stamp.cjs');
const { resolveWebBuildRevision } = require('../scripts/build-revision.cjs');

const configPath = path.resolve(__dirname, '../next.config.js');
const sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-cafe-web-stamp-'));
  sandboxes.push(dir);
  return dir;
}

// A directory that is provably outside any git checkout, so the git fallback
// inside resolveWebBuildRevision genuinely fails instead of silently picking up
// the repository this test happens to run in.
function makeNonGitRoot() {
  const dir = makeSandbox();
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: 'ignore' });
    return null; // sandbox unexpectedly sits inside a repo — caller skips
  } catch {
    return dir;
  }
}

// next.config.js is loaded without workspace node_modules here, so stub the PWA
// wrapper the same way test/next-config.test.cjs does.
function loadConfigRevision(env) {
  const snapshot = process.env.CAT_CAFE_WEB_BUILD_REVISION;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@ducanh2912/next-pwa') return { default: () => (config) => config };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    if (env.CAT_CAFE_WEB_BUILD_REVISION === undefined) delete process.env.CAT_CAFE_WEB_BUILD_REVISION;
    else process.env.CAT_CAFE_WEB_BUILD_REVISION = env.CAT_CAFE_WEB_BUILD_REVISION;
    delete require.cache[configPath];
    return require(configPath).env?.NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION;
  } finally {
    delete require.cache[configPath];
    Module._load = originalLoad;
    if (snapshot === undefined) delete process.env.CAT_CAFE_WEB_BUILD_REVISION;
    else process.env.CAT_CAFE_WEB_BUILD_REVISION = snapshot;
  }
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('web build stamp', () => {
  it('records the revision at the exact path the API reads', () => {
    const webPackageDir = makeSandbox();
    const revision = 'A'.repeat(40);

    const written = writeBuildStamp({
      webPackageDir,
      env: { CAT_CAFE_WEB_BUILD_REVISION: `  ${revision}\n` },
    });

    assert.equal(written, path.join(webPackageDir, DIST_DIR_NAME, STAMP_FILE_NAME));
    assert.equal(path.join(DIST_DIR_NAME, STAMP_FILE_NAME), path.join('.next', '.build-commit'));
    // API reads with .trim(); store the normalized lowercase commit.
    assert.equal(fs.readFileSync(written, 'utf8').trim(), 'a'.repeat(40));
  });

  it('creates the stamp even when next build produced a fresh .next directory', () => {
    const webPackageDir = makeSandbox();
    assert.equal(fs.existsSync(path.join(webPackageDir, DIST_DIR_NAME)), false);

    const written = writeBuildStamp({
      webPackageDir,
      env: { CAT_CAFE_WEB_BUILD_REVISION: 'b'.repeat(40) },
    });

    assert.ok(written && fs.existsSync(written));
  });

  it('never invents deployment identity when the revision is unresolvable', () => {
    const repoRoot = makeNonGitRoot();
    if (!repoRoot) return; // sandbox is inside a repo; nothing to assert
    const webPackageDir = makeSandbox();

    const written = writeBuildStamp({
      webPackageDir,
      repoRoot,
      env: { CAT_CAFE_WEB_BUILD_REVISION: 'not-a-commit' },
    });

    assert.equal(written, null);
    assert.equal(fs.existsSync(buildStampPath(webPackageDir)), false);
  });

  it('stamps exactly what next.config.js embedded into the browser bundle', () => {
    // Drift between these two is the failure that F294 fails closed on: a stamp
    // that disagrees with the shipped bundle blocks writes just as hard as a
    // missing one.
    const explicit = 'c'.repeat(40);
    assert.equal(
      resolveWebBuildRevision({ env: { CAT_CAFE_WEB_BUILD_REVISION: explicit } }),
      loadConfigRevision({ CAT_CAFE_WEB_BUILD_REVISION: explicit }),
    );

    // Also cover the git fallback, which is what real runtime builds use and
    // which depends on both call sites resolving the same repository root.
    assert.equal(resolveWebBuildRevision({ env: {} }), loadConfigRevision({ CAT_CAFE_WEB_BUILD_REVISION: undefined }));
  });
});

describe('web build pipeline wiring', () => {
  it('runs the stamp writer from next build itself, not from a launcher', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    assert.match(pkg.scripts.postbuild ?? '', /write-build-stamp\.cjs/);
  });
});
