const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');

const { inspectWebProductionBuild } = require('../scripts/ensure-browser-test-artifacts.cjs');
const { writeBuildStamp } = require('../scripts/write-build-stamp.cjs');

const sandboxes = [];

function makeWebRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cat-cafe-browser-artifacts-'));
  sandboxes.push(root);
  return root;
}

function writeBuild(root, { buildId = 'build-id', stamp } = {}) {
  mkdirSync(path.join(root, '.next'), { recursive: true });
  writeFileSync(path.join(root, '.next', 'BUILD_ID'), `${buildId}\n`);
  if (stamp !== undefined) writeFileSync(path.join(root, '.next', '.build-commit'), `${stamp}\n`);
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('browser-test production artifact freshness', () => {
  const head = 'a'.repeat(40);

  it('requires a production build and an exact revision stamp', () => {
    const webRoot = makeWebRoot();
    assert.deepEqual(inspectWebProductionBuild({ webRoot, head, dirtyInputs: false }), {
      fresh: false,
      reason: 'missing .next/BUILD_ID',
    });

    writeBuild(webRoot);
    assert.deepEqual(inspectWebProductionBuild({ webRoot, head, dirtyInputs: false }), {
      fresh: false,
      reason: 'missing .next/.build-commit',
    });

    writeBuild(webRoot, { stamp: 'b'.repeat(40) });
    assert.deepEqual(inspectWebProductionBuild({ webRoot, head, dirtyInputs: false }), {
      fresh: false,
      reason: 'Web build revision does not match HEAD',
    });
  });

  it('never reuses an artifact produced from dirty inputs after the checkout becomes clean', () => {
    const webRoot = makeWebRoot();
    writeBuild(webRoot);

    const written = writeBuildStamp({
      webPackageDir: webRoot,
      env: { CAT_CAFE_WEB_BUILD_REVISION: head },
      dirtyInputs: true,
    });

    assert.equal(written, null);
    assert.deepEqual(inspectWebProductionBuild({ webRoot, head, dirtyInputs: false }), {
      fresh: false,
      reason: 'missing .next/.build-commit',
    });
  });

  it('reuses only the clean exact-HEAD Web build', () => {
    const webRoot = makeWebRoot();
    writeBuild(webRoot, { stamp: head });

    assert.deepEqual(inspectWebProductionBuild({ webRoot, head, dirtyInputs: false }), {
      fresh: true,
      reason: 'Web production build matches the clean HEAD',
    });
    assert.deepEqual(inspectWebProductionBuild({ webRoot, head, dirtyInputs: true }), {
      fresh: false,
      reason: 'Web build inputs have uncommitted changes',
    });
  });
});
