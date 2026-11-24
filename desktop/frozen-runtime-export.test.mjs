import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportFrozenRuntime, materialize } from './scripts/frozen-runtime-export.mjs';

test('rejects stale or unstamped API artifacts before exporting a revision-bound release', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-revision-'));
  const revision = 'a'.repeat(40);
  const stamp = path.join(workspace, 'packages/api/dist/.build-commit');
  const out = path.join(workspace, 'export');
  const lock = path.join(workspace, 'pnpm-lock.yaml');
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'node_modules'));
  fs.writeFileSync(lock, 'fixture lock');
  fs.writeFileSync(path.join(workspace, 'packages/api/package.json'), '{"name":"api"}');
  const exportRelease = (expected = revision) =>
    exportFrozenRuntime(workspace, out, ['api'], lock, { expectedWebBuildCommit: expected });
  try {
    for (const input of [null, '', 'b'.repeat(40), 'not-a-commit']) {
      if (input !== null) fs.writeFileSync(stamp, input);
      assert.throws(exportRelease, /API build identity does not match/, `API stamp: ${input}`);
      assert.equal(fs.existsSync(out), false, 'a rejected release must not leave an export');
    }
    fs.writeFileSync(stamp, revision);
    assert.throws(() => exportRelease('invalid'), /API build identity does not match/);
    exportRelease();
    assert.equal(fs.readFileSync(path.join(out, 'api/dist/.build-commit'), 'utf8'), revision);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

for (const sharedDependencies of [false, true])
  test(`exports portable frozen nested/peer/workspace packages (shared=${sharedDependencies})`, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-export-'));
    const workspace = path.join(base, 'workspace');
    const file = (relative, value) => {
      const target = path.join(workspace, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, value);
    };
    try {
      file('pnpm-lock.yaml', 'locked fixture');
      file('packages/api/package.json', '{"name":"api"}');
      file('packages/api/dist/index.cjs', 'module.exports = require("nested")');
      file('packages/api/test/dev-fixture.js', 'development-only');
      file('packages/api/dist/types.d.ts', 'export type Internal = string');
      file('packages/api/src/plugins/runtime/native.swift', 'runtime-asset');
      file('packages/shared/package.json', '{"name":"@cat-cafe/shared","main":"index.cjs"}');
      file('packages/shared/index.cjs', 'module.exports = {value: 7}');
      file('node_modules/@fastify/send/package.json', '{"name":"@fastify/send","main":"index.cjs"}');
      file('node_modules/@fastify/send/index.cjs', 'module.exports = 5');
      file('node_modules/@fastify/send/test/fixtures/snow \u2603/index.txt', 'fixture only');
      file('node_modules/nested/package.json', '{"name":"nested","version":"1.0.0","main":"index.cjs"}');
      file('node_modules/nested/index.cjs', 'module.exports = require("peer")');
      file('node_modules/peer/package.json', '{"name":"peer","version":"1.0.0","main":"index.cjs"}');
      file('node_modules/peer/index.cjs', 'module.exports = 1');
      file(
        'node_modules/nested/node_modules/peer/package.json',
        '{"name":"peer","version":"2.0.0","main":"index.cjs"}',
      );
      file('node_modules/nested/node_modules/peer/index.cjs', 'module.exports = 2');
      file('node_modules/override/package.json', '{"name":"override","main":"index.cjs"}');
      file('node_modules/override/index.cjs', 'module.exports = require("peer")');
      file('node_modules/override/node_modules/peer/package.json', '{"name":"peer","main":"index.cjs"}');
      file('node_modules/override/node_modules/peer/index.cjs', 'module.exports = 99');
      file('packages/api/node_modules/override/package.json', '{"name":"override","main":"index.cjs"}');
      file('packages/api/node_modules/override/index.cjs', 'module.exports = require("peer")');
      fs.mkdirSync(path.join(workspace, 'node_modules/@cat-cafe'));
      fs.symlinkSync(
        path.join(workspace, 'packages/shared'),
        path.join(workspace, 'node_modules/@cat-cafe/shared'),
        'junction',
      );
      fs.mkdirSync(path.join(workspace, 'packages/api/node_modules/@cat-cafe'), { recursive: true });
      fs.symlinkSync(
        path.join(workspace, 'packages/shared'),
        path.join(workspace, 'packages/api/node_modules/@cat-cafe/shared'),
        'junction',
      );
      const out = path.join(base, 'output');
      exportFrozenRuntime(workspace, out, ['api'], path.join(workspace, 'pnpm-lock.yaml'), { sharedDependencies });
      assert.equal(fs.existsSync(path.join(out, 'api/node_modules/nested')), !sharedDependencies);
      assert.equal(fs.existsSync(path.join(out, 'dependencies/nested')), sharedDependencies);
      assert.equal(fs.existsSync(path.join(out, 'api/node_modules/@cat-cafe/shared')), !sharedDependencies);
      const moved = path.join(base, 'moved');
      fs.renameSync(out, moved);
      if (sharedDependencies) fs.renameSync(path.join(moved, 'dependencies'), path.join(moved, 'node_modules'));
      const require = createRequire(path.join(moved, 'api/package.json'));
      assert.equal(require('./dist/index.cjs'), 2);
      assert.equal(fs.existsSync(path.join(moved, 'api/test')), !sharedDependencies);
      assert.equal(fs.existsSync(path.join(moved, 'api/dist/types.d.ts')), !sharedDependencies);
      assert.equal(fs.readFileSync(path.join(moved, 'api/src/plugins/runtime/native.swift'), 'utf8'), 'runtime-asset');
      assert.equal(require('@cat-cafe/shared').value, 7);
      if (sharedDependencies) {
        const rootRequire = createRequire(path.join(moved, 'package.json'));
        assert.equal(require('@cat-cafe/shared'), rootRequire('@cat-cafe/shared'));
      }
      assert.equal(require('@fastify/send'), 5);
      const modules = path.join(moved, sharedDependencies ? 'node_modules' : 'api/node_modules');
      assert.equal(fs.existsSync(path.join(modules, '@fastify/send/test')), false);
      assert.equal(require('override'), 1, 'private version must not inherit another version leftover peers');
      assert.equal(fs.lstatSync(path.join(modules, '@cat-cafe/shared')).isSymbolicLink(), false);
      assert.throws(
        () => exportFrozenRuntime(workspace, moved, ['api'], path.join(workspace, 'pnpm-lock.yaml')),
        /must be new/,
      );
      file('pnpm-lock.yaml', 'drift');
      fs.writeFileSync(path.join(base, 'source-lock'), 'locked fixture');
      assert.throws(
        () => exportFrozenRuntime(workspace, path.join(base, 'drift'), ['api'], path.join(base, 'source-lock')),
        /lock changed/,
      );
      fs.symlinkSync(os.tmpdir(), path.join(workspace, 'escape'), 'junction');
      assert.throws(() => materialize(path.join(workspace, 'escape'), path.join(base, 'bad'), workspace), /External/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

for (const sharedDependencies of [false, true])
  for (const targetPlatform of ['win32-x64', 'win32-arm64', 'darwin-arm64'])
    test(`native runtime export preserves target files and private packages (${targetPlatform}, shared=${sharedDependencies})`, () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-native-target-'));
      const workspace = path.join(base, 'workspace');
      const file = (relative, value) => {
        const target = path.join(workspace, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, value);
      };
      const foreign = ['win32-arm64', 'linux-arm64', 'linux-x64', 'darwin-arm64', 'darwin-x64'];
      try {
        file('pnpm-lock.yaml', 'locked fixture');
        file('packages/api/package.json', '{"name":"api"}');
        file('packages/api/node_modules/terminal-helper/package.json', '{"name":"terminal-helper"}');
        for (const location of [
          'node_modules/node-pty',
          'packages/api/node_modules/terminal-helper/node_modules/node-pty',
        ]) {
          file(`${location}/package.json`, '{"name":"node-pty","version":"1.2.0-beta.12"}');
          for (const architecture of ['win32-x64', 'future-platform', ...foreign])
            file(`${location}/prebuilds/${architecture}/binding.node`, architecture);
          file(`${location}/prebuilds/win32-x64/conpty.pdb`, 'keep target debug symbols');
          file(`${location}/lib/index.js.map`, 'keep source maps');
          file(`${location}/vendor/darwin-arm64/data`, 'unclassified runtime asset');
        }
        file('node_modules/other-package/package.json', '{"name":"other-package"}');
        file('node_modules/other-package/prebuilds/linux-x64/binding.node', 'unrelated package');
        file('node_modules/alias-root/package.json', '{"name":"alias-root"}');
        file('node_modules/alias-root/node_modules/node-pty/package.json', '{"name":"different-package"}');
        file('node_modules/alias-root/node_modules/node-pty/prebuilds/linux-x64/data', 'preserve different identity');
        const out = path.join(base, 'output');
        exportFrozenRuntime(workspace, out, ['api'], path.join(workspace, 'pnpm-lock.yaml'), {
          sharedDependencies,
          targetPlatform,
        });
        const modules = path.join(out, sharedDependencies ? 'dependencies' : 'api/node_modules');
        for (const destination of [
          path.join(modules, 'node-pty'),
          path.join(out, 'api/node_modules/terminal-helper/node_modules/node-pty'),
        ]) {
          for (const architecture of foreign)
            assert.equal(
              fs.existsSync(path.join(destination, 'prebuilds', architecture)),
              targetPlatform !== 'win32-x64',
              architecture,
            );
          for (const relative of [
            'prebuilds/win32-x64/binding.node',
            'prebuilds/win32-x64/conpty.pdb',
            'prebuilds/future-platform/binding.node',
            'lib/index.js.map',
            'vendor/darwin-arm64/data',
          ])
            assert.equal(fs.existsSync(path.join(destination, relative)), true, relative);
        }
        assert.equal(fs.existsSync(path.join(modules, 'other-package/prebuilds/linux-x64/binding.node')), true);
        assert.equal(
          fs.existsSync(path.join(modules, 'alias-root/node_modules/node-pty/prebuilds/linux-x64/data')),
          true,
        );
        assert.equal(
          fs.existsSync(path.join(workspace, 'node_modules/node-pty/prebuilds/win32-arm64/binding.node')),
          true,
          'never prune source dependencies',
        );
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

test('native prebuild filtering cannot hide a link outside the frozen workspace', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'native-filter-link-'));
  const workspace = path.join(base, 'workspace');
  try {
    fs.mkdirSync(path.join(workspace, 'node_modules/node-pty/prebuilds'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'packages/api'), { recursive: true });
    fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(workspace, 'pnpm-lock.yaml'), 'locked');
    fs.writeFileSync(path.join(workspace, 'packages/api/package.json'), '{"name":"api"}');
    fs.writeFileSync(path.join(workspace, 'node_modules/node-pty/package.json'), '{"name":"node-pty"}');
    fs.symlinkSync(
      path.join(base, 'outside'),
      path.join(workspace, 'node_modules/node-pty/prebuilds/win32-arm64'),
      'junction',
    );
    assert.throws(
      () =>
        exportFrozenRuntime(workspace, path.join(base, 'output'), ['api'], path.join(workspace, 'pnpm-lock.yaml'), {
          targetPlatform: 'win32-x64',
        }),
      /External packaging link/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
