import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportFrozenRuntime } from './scripts/frozen-runtime-export.mjs';

test('production selection omits Web build-only packages, retaining server graphs, private peers and identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-runtime-graph-'));
  const workspace = path.join(root, 'workspace');
  const write = (relative, text) => {
    const file = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const pkg = (relative, name, dependencies = {}, extra = {}) => {
    write(
      `${relative}/package.json`,
      JSON.stringify({ name, version: '1.0.0', main: 'index.cjs', dependencies, ...extra }),
    );
    write(`${relative}/index.cjs`, 'module.exports={};');
  };
  try {
    write('pnpm-lock.yaml', 'locked fixture');
    pkg('packages/api', 'api', { nested: '1', '@cat-cafe/shared': 'workspace:*' });
    pkg('packages/mcp-server', 'mcp', { '@cat-cafe/shared': 'workspace:*' });
    pkg('packages/web', 'web', { 'client-only-widget': '1', next: '1' });
    pkg('packages/shared', '@cat-cafe/shared');
    pkg('node_modules/nested', 'nested', { peer: '2' });
    write('node_modules/nested/index.cjs', 'module.exports=require("peer");');
    pkg('node_modules/nested/node_modules/peer', 'peer');
    write('node_modules/nested/node_modules/peer/index.cjs', 'module.exports=2;');
    pkg('node_modules/peer', 'peer');
    write('node_modules/peer/index.cjs', 'module.exports=1;');
    pkg('node_modules/client-only-widget', 'client-only-widget');
    pkg(
      'node_modules/next',
      'next',
      { 'server-dependency': '1', absent: '1' },
      { optionalDependencies: { absent: '1' } },
    );
    pkg('node_modules/server-dependency', 'server-dependency');
    pkg('node_modules/ssr-external', 'ssr-external');
    pkg('packages/web/node_modules/private-ssr', 'private-ssr', { 'web-private-leaf': '1' });
    pkg('node_modules/web-private-leaf', 'web-private-leaf');
    pkg('node_modules/config-runtime-plugin', 'config-runtime-plugin', { 'config-leaf': '1' });
    pkg('node_modules/config-leaf', 'config-leaf');
    write('packages/web/next.config.js', "module.exports=require('./scripts/runtime-config.cjs');");
    write('packages/web/scripts/runtime-config.cjs', "module.exports=require('config-runtime-plugin');");
    pkg('node_modules/private-container', 'private-container', { 'traced-private': '2' });
    pkg(
      'node_modules/private-container/node_modules/traced-private',
      'traced-private',
      { 'private-leaf': '1' },
      { version: '2.0.0' },
    );
    write('node_modules/private-container/node_modules/traced-private/asset.wasm', 'private-asset');
    pkg('node_modules/traced-private', 'traced-private');
    pkg('node_modules/private-leaf', 'private-leaf');
    pkg('node_modules/other-private-owner', 'other-private-owner');
    pkg('node_modules/other-private-owner/node_modules/traced-private', 'traced-private', {}, { version: '2.0.0' });
    write('node_modules/other-private-owner/node_modules/traced-private/asset.wasm', 'other-private-asset');
    pkg('node_modules/.pnpm/traced-private@2/node_modules/traced-private', 'traced-private', {}, { version: '2.0.0' });
    write('node_modules/.pnpm/traced-private@2/node_modules/traced-private/asset.wasm', 'virtual-source-asset');
    write('node_modules/ssr-external/asset.wasm', 'runtime-asset');
    fs.mkdirSync(path.join(workspace, 'node_modules/@cat-cafe'), { recursive: true });
    fs.symlinkSync(
      path.join(workspace, 'packages/shared'),
      path.join(workspace, 'node_modules/@cat-cafe/shared'),
      'junction',
    );
    write('packages/web/.next/BUILD_ID', 'built');
    write('packages/web/.next/.build-commit', 'a'.repeat(40));
    write('packages/api/dist/.build-commit', 'a'.repeat(40));
    write(
      'packages/web/.next/next-server.js.nft.json',
      JSON.stringify({ version: 1, files: ['../../../node_modules/next/index.cjs'] }),
    );
    write(
      'packages/web/.next/server/page.js.nft.json',
      JSON.stringify({
        version: 1,
        files: [
          '../../../../node_modules/ssr-external/index.cjs',
          '../../../../node_modules/private-container/node_modules/traced-private/asset.wasm',
          '../../../../node_modules/.pnpm/traced-private@2/node_modules/traced-private/asset.wasm',
          '../../node_modules/private-ssr/index.cjs',
        ],
      }),
    );
    const options = {
      sharedDependencies: true,
      pruneWebBuildDependencies: true,
      expectedWebBuildCommit: 'a'.repeat(40),
    };
    const output = path.join(root, 'output');
    const receipt = exportFrozenRuntime(
      workspace,
      output,
      ['api', 'mcp-server', 'web'],
      path.join(workspace, 'pnpm-lock.yaml'),
      options,
    );
    assert.equal(fs.existsSync(path.join(output, 'dependencies/client-only-widget')), false);
    assert.ok(fs.existsSync(path.join(output, 'dependencies/ssr-external/asset.wasm')));
    assert.ok(fs.existsSync(path.join(output, 'dependencies/server-dependency')));
    assert.ok(
      fs.existsSync(path.join(output, 'dependencies/private-container/node_modules/traced-private/asset.wasm')),
    );
    assert.ok(
      fs.existsSync(path.join(output, 'dependencies/other-private-owner/node_modules/traced-private/asset.wasm')),
    );
    assert.ok(fs.existsSync(path.join(output, 'dependencies/private-leaf')));
    assert.ok(fs.existsSync(path.join(output, 'dependencies/config-runtime-plugin')));
    assert.ok(fs.existsSync(path.join(output, 'dependencies/config-leaf')));
    assert.ok(fs.existsSync(path.join(output, 'web/node_modules/private-ssr/index.cjs')));
    assert.ok(fs.existsSync(path.join(output, 'dependencies/web-private-leaf')));
    fs.renameSync(path.join(output, 'dependencies'), path.join(output, 'node_modules'));
    const requireApi = createRequire(path.join(output, 'api/package.json'));
    assert.equal(requireApi('nested'), 2);
    assert.equal(fs.existsSync(path.join(output, 'node_modules/peer')), false);
    assert.equal(fs.existsSync(path.join(output, 'node_modules/traced-private')), false);
    assert.equal(requireApi('@cat-cafe/shared'), createRequire(path.join(output, 'package.json'))('@cat-cafe/shared'));
    assert.ok(receipt.webRuntimeSelection.excludedRootPackages.includes('client-only-widget'));
    write('packages/web/.next/.build-commit', 'b'.repeat(40));
    assert.throws(
      () =>
        exportFrozenRuntime(
          workspace,
          path.join(root, 'stale'),
          ['api', 'web'],
          path.join(workspace, 'pnpm-lock.yaml'),
          options,
        ),
      /Web build identity/,
    );
    write('packages/web/.next/.build-commit', 'a'.repeat(40));
    fs.unlinkSync(path.join(workspace, 'packages/web/.next/next-server.js.nft.json'));
    assert.throws(
      () =>
        exportFrozenRuntime(
          workspace,
          path.join(root, 'missing'),
          ['api', 'web'],
          path.join(workspace, 'pnpm-lock.yaml'),
          options,
        ),
      /production server trace/,
    );
    write('packages/web/.next/next-server.js.nft.json', JSON.stringify({ version: 1, files: [] }));
    pkg('node_modules/server-dependency', 'server-dependency', { 'required-missing': '1' });
    assert.throws(
      () =>
        exportFrozenRuntime(
          workspace,
          path.join(root, 'unresolved'),
          ['api', 'web'],
          path.join(workspace, 'pnpm-lock.yaml'),
          options,
        ),
      /Unresolved runtime dependency/,
    );
    pkg('node_modules/server-dependency', 'server-dependency');
    write('packages/web/scripts/runtime-config.cjs', 'module.exports=require(process.env.CONFIG_DEPENDENCY);');
    assert.throws(
      () =>
        exportFrozenRuntime(
          workspace,
          path.join(root, 'dynamic'),
          ['api', 'web'],
          path.join(workspace, 'pnpm-lock.yaml'),
          options,
        ),
      /Untraceable Next configuration dependency/,
    );
    write('packages/web/scripts/runtime-config.cjs', "module.exports=module.require('config-runtime-plugin');");
    const moduleOutput = path.join(root, 'module-loader');
    exportFrozenRuntime(workspace, moduleOutput, ['api', 'web'], path.join(workspace, 'pnpm-lock.yaml'), options);
    assert.ok(fs.existsSync(path.join(moduleOutput, 'dependencies/config-runtime-plugin')));
    write(
      'packages/web/scripts/runtime-config.cjs',
      "const load=require; module.exports=load('config-runtime-plugin');",
    );
    assert.throws(
      () =>
        exportFrozenRuntime(
          workspace,
          path.join(root, 'alias'),
          ['api', 'web'],
          path.join(workspace, 'pnpm-lock.yaml'),
          options,
        ),
      /Untraceable Next configuration loader/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
