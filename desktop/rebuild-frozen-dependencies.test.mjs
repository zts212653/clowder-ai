import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { rebuildFrozenDependencies, resolveNpmCli } from './scripts/rebuild-frozen-dependencies.mjs';

test('resolves npm from Windows and macOS Node distribution layouts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-layout-'));
  try {
    for (const layout of ['windows/node_modules/npm/bin/npm-cli.js', 'mac/lib/node_modules/npm/bin/npm-cli.js']) {
      const file = path.join(root, layout);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fixture');
    }
    assert.equal(
      resolveNpmCli(path.join(root, 'windows/node.exe')),
      path.join(root, 'windows/node_modules/npm/bin/npm-cli.js'),
    );
    assert.equal(
      resolveNpmCli(path.join(root, 'mac/bin/node')),
      path.join(root, 'mac/lib/node_modules/npm/bin/npm-cli.js'),
    );
    assert.throws(() => resolveNpmCli(path.join(root, 'missing/node')), /must include npm/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runs each dependency lifecycle once and invokes default binding.gyp installation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-hook-'));
  const events = path.join(root, 'events.jsonl');
  const sentinel = path.join(root, 'sentinel.cjs');
  try {
    fs.mkdirSync(path.join(root, 'packages'));
    fs.writeFileSync(
      sentinel,
      `require('fs').appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: process.env.npm_lifecycle_event, args: process.argv.slice(2) }) + '\\n');`,
    );
    const script = `node "${sentinel}"`;
    for (const [name, scripts] of [
      ['explicit', { preinstall: script, install: script, postinstall: script }],
      ['implicit', {}],
    ]) {
      const dir = path.join(root, 'node_modules', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts }));
      if (name === 'implicit') fs.writeFileSync(path.join(dir, 'binding.gyp'), '{}');
    }
    await rebuildFrozenDependencies(root, { ...process.env, npm_config_node_gyp: sentinel });
    const recorded = fs
      .readFileSync(events, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      recorded.map((entry) => entry.event),
      ['preinstall', 'install', 'postinstall', 'install'],
    );
    assert.deepEqual(recorded[3].args, ['rebuild']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonicalizes an owned workspace alias and still rejects an external dependency', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-alias-'));
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  try {
    const owned = path.join(actual, 'node_modules', 'owned');
    fs.mkdirSync(owned, { recursive: true });
    fs.mkdirSync(path.join(actual, 'packages'));
    fs.writeFileSync(path.join(owned, 'package.json'), JSON.stringify({ name: 'owned', version: '1' }));
    fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await rebuildFrozenDependencies(alias);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ name: 'outside', version: '1' }));
    fs.symlinkSync(
      outside,
      path.join(actual, 'node_modules', 'outside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(() => rebuildFrozenDependencies(alias), /External dependency/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
