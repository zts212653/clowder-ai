const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveProjectRootFromDir } = require('./project-root');

function seedRuntimeRoot(rootDir, { withNodeModules }) {
  mkdirSync(path.join(rootDir, 'packages', 'api', 'dist'), { recursive: true });
  writeFileSync(path.join(rootDir, 'packages', 'api', 'dist', 'index.js'), 'module.exports = {};\n');
  if (withNodeModules) {
    mkdirSync(path.join(rootDir, 'packages', 'api', 'node_modules'), { recursive: true });
  }
}

test('prefers the repo root when the current desktop checkout is runtime-complete', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'desktop-root-dev-'));
  try {
    seedRuntimeRoot(tempRoot, { withNodeModules: true });
    const startDir = path.join(tempRoot, 'desktop');
    mkdirSync(startDir, { recursive: true });
    assert.equal(resolveProjectRootFromDir(startDir), tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('skips Windows resources root when extraResources is missing node_modules', () => {
  const installRoot = mkdtempSync(path.join(tmpdir(), 'desktop-root-win-'));
  try {
    seedRuntimeRoot(installRoot, { withNodeModules: true });

    const resourcesRoot = path.join(installRoot, 'desktop-dist', 'resources');
    seedRuntimeRoot(resourcesRoot, { withNodeModules: false });

    const startDir = path.join(resourcesRoot, 'app');
    mkdirSync(startDir, { recursive: true });
    assert.equal(resolveProjectRootFromDir(startDir), installRoot);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test('accepts macOS Resources root after afterPack copies node_modules', () => {
  const bundleRoot = mkdtempSync(path.join(tmpdir(), 'desktop-root-mac-'));
  try {
    const resourcesRoot = path.join(bundleRoot, 'Cat Cafe.app', 'Contents', 'Resources');
    seedRuntimeRoot(resourcesRoot, { withNodeModules: true });

    const startDir = path.join(resourcesRoot, 'app');
    mkdirSync(startDir, { recursive: true });
    assert.equal(resolveProjectRootFromDir(startDir), resourcesRoot);
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});
