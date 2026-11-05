import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bundleDesktopApi } from './scripts/bundle-desktop-api.mjs';

test('desktop bundles selected JS dependencies, preserving external singleton identities and native assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-dependencies-'));
  try {
    const exported = path.join(root, 'export');
    const api = path.join(exported, 'api');
    const write = (relative, text) => {
      const file = path.join(api, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    write('package.json', '{"type":"module"}');
    for (const name of ['@cat-cafe/shared', '@clowder-ai/plugin-contract', '@opentelemetry/api', 'better-sqlite3'])
      write(`node_modules/${name}/package.json`, JSON.stringify({ name, main: 'index.cjs' }));
    write('../dependencies/yaml/package.json', '{"name":"yaml","main":"index.cjs"}');
    write('../dependencies/yaml/index.cjs', "module.exports=require('./part.cjs');");
    write('../dependencies/yaml/part.cjs', "module.exports=require('node:path').basename('/value/ok');");
    for (const name of ['@cat-cafe/shared', '@clowder-ai/plugin-contract', '@opentelemetry/api'])
      write(`node_modules/${name}/index.cjs`, 'module.exports={identity:{}};');
    write('node_modules/better-sqlite3/asset.json', '{"value":9}');
    write('node_modules/better-sqlite3/index.cjs', "module.exports=require('./asset.json');");
    write(
      'dist/index.js',
      `import yaml from 'yaml'; import shared from '@cat-cafe/shared';
import contract from '@clowder-ai/plugin-contract'; import otel from '@opentelemetry/api';
import native from 'better-sqlite3'; import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
console.log(JSON.stringify({yaml,native:native.value,shared:shared===require('@cat-cafe/shared'),
contract:contract===require('@clowder-ai/plugin-contract'),otel:otel===require('@opentelemetry/api')}));`,
    );
    const receipt = await bundleDesktopApi(api);
    const moved = path.join(root, 'moved');
    fs.renameSync(exported, moved);
    // A genuine absence check: the selected dependency is no longer read at runtime.
    fs.renameSync(path.join(moved, 'dependencies/yaml'), path.join(moved, 'dependencies/yaml-not-readable'));
    const result = JSON.parse(
      execFileSync(process.execPath, [path.join(moved, 'api/dist/index.desktop.js')], { encoding: 'utf8' }),
    );
    assert.deepEqual(result, { yaml: 'ok', native: 9, shared: true, contract: true, otel: true });
    assert.ok(receipt.bundledPackages.includes('yaml'));
    assert.ok(!receipt.bundledPackages.includes('@opentelemetry/api'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dependency upgrades adding location-dependent assets must stop the bundle build', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-dependency-assets-'));
  try {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.mkdirSync(path.join(root, 'node_modules/yaml'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(root, 'dist/index.js'), "import value from 'yaml'; console.log(value);");
    fs.writeFileSync(path.join(root, 'node_modules/yaml/package.json'), '{"main":"index.cjs"}');
    fs.writeFileSync(path.join(root, 'node_modules/yaml/index.cjs'), 'module.exports=__dirname;');
    await assert.rejects(bundleDesktopApi(root), /external asset boundary/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bundling must reject external private peers that resolve differently from the API entry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-private-peer-'));
  try {
    const write = (relative, value) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    };
    write('package.json', '{"type":"module"}');
    write('dist/index.js', "import value from 'yaml'; console.log(value);");
    write('node_modules/yaml/package.json', '{"main":"index.cjs"}');
    write('node_modules/yaml/index.cjs', "module.exports=require('private-peer');");
    for (const prefix of ['node_modules', 'node_modules/yaml/node_modules']) {
      write(`${prefix}/private-peer/package.json`, '{"main":"index.cjs"}');
      write(`${prefix}/private-peer/index.cjs`, `module.exports=${JSON.stringify(prefix)};`);
    }
    await assert.rejects(bundleDesktopApi(root), /external dependency identity/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
