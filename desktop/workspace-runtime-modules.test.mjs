import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportFrozenRuntime } from './scripts/frozen-runtime-export.mjs';

for (const rootWorkspace of [true, false]) {
  test(`same name/version with a different identity keeps private resolution (rootWorkspace=${rootWorkspace})`, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-identity-'));
    const workspace = path.join(base, 'workspace');
    const write = (file, body) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    };
    const pkg = (dir, value) => {
      write(path.join(dir, 'package.json'), '{"name":"@cat-cafe/shared","version":"1.0.0","main":"index.cjs"}');
      write(path.join(dir, 'index.cjs'), `module.exports=${value}`);
    };
    const link = (from, to) => {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.symlinkSync(from, to, 'junction');
    };
    try {
      write(path.join(workspace, 'pnpm-lock.yaml'), 'locked');
      write(path.join(workspace, 'packages/api/package.json'), '{"name":"api"}');
      const root = path.join(workspace, 'node_modules/@cat-cafe/shared');
      if (rootWorkspace) {
        const source = path.join(workspace, 'packages/shared-root');
        pkg(source, 7);
        link(source, root);
      } else pkg(root, 7);
      const other = path.join(workspace, 'packages/shared-private');
      pkg(other, 11);
      link(other, path.join(workspace, 'packages/api/node_modules/@cat-cafe/shared'));
      const out = path.join(base, 'output');
      const receipt = exportFrozenRuntime(workspace, out, ['api'], path.join(workspace, 'pnpm-lock.yaml'), {
        sharedDependencies: true,
      });
      assert.deepEqual(receipt.sharedWorkspacePackages, []);
      fs.renameSync(path.join(out, 'dependencies'), path.join(out, 'node_modules'));
      const moved = path.join(base, 'moved');
      fs.renameSync(out, moved);
      assert.equal(createRequire(path.join(moved, 'api/package.json'))('@cat-cafe/shared'), 11);
      assert.equal(createRequire(path.join(moved, 'package.json'))('@cat-cafe/shared'), 7);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}

test('a private dependency linked below a workspace keeps its original peer island', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-peer-island-'));
  const workspace = path.join(base, 'workspace');
  const write = (relative, body) => {
    const file = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const pkg = (relative, name, body) => {
    write(`${relative}/package.json`, JSON.stringify({ name, main: 'index.cjs' }));
    write(`${relative}/index.cjs`, body);
  };
  try {
    write('pnpm-lock.yaml', 'locked');
    write('packages/api/package.json', '{"name":"api"}');
    pkg('node_modules/peer', 'peer', 'module.exports=1');
    pkg('packages/api/node_modules/peer', 'peer', 'module.exports=2');
    pkg('packages/api/node_modules/island/node_modules/peer', 'peer', 'module.exports=2');
    pkg('packages/api/node_modules/island/node_modules/peer-owner', 'peer-owner', 'module.exports=require("peer")');
    fs.symlinkSync(
      path.join(workspace, 'packages/api/node_modules/island/node_modules/peer-owner'),
      path.join(workspace, 'packages/api/node_modules/peer-owner'),
      'junction',
    );
    assert.equal(createRequire(path.join(workspace, 'packages/api/package.json'))('peer-owner'), 2);
    const out = path.join(base, 'out');
    const receipt = exportFrozenRuntime(workspace, out, ['api'], path.join(workspace, 'pnpm-lock.yaml'), {
      sharedDependencies: true,
    });
    assert.deepEqual(receipt.sharedWorkspacePackages, []);
    fs.renameSync(path.join(out, 'dependencies'), path.join(out, 'node_modules'));
    assert.equal(createRequire(path.join(out, 'api/package.json'))('peer-owner'), 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
