import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRuntimeArchive } from './scripts/create-runtime-archive.mjs';
import { exportFrozenRuntime } from './scripts/frozen-runtime-export.mjs';

for (const sharedDependencies of [false, true])
  test(`exports SDK JavaScript without Claude native packages (shared=${sharedDependencies})`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-export-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'source');
    const write = (name, content) => {
      const target = path.join(workspace, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    write('pnpm-lock.yaml', 'fixture');
    write('packages/api/package.json', '{"name":"api"}');
    write('node_modules/@anthropic-ai/claude-agent-sdk/package.json', '{"name":"@anthropic-ai/claude-agent-sdk"}');
    write('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', 'export const query = () => {};');
    for (const prefix of ['node_modules', 'packages/api/node_modules', 'node_modules/adapter/node_modules']) {
      for (const platform of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
        const name = `@anthropic-ai/claude-agent-sdk-${platform}`;
        write(`${prefix}/${name}/package.json`, JSON.stringify({ name }));
        write(`${prefix}/${name}/claude.exe`, 'native-program');
      }
      write(`${prefix}/sharp/package.json`, '{"name":"sharp"}');
      write(`${prefix}/sharp/sharp.node`, 'unrelated-required-native');
    }
    write('node_modules/adapter/package.json', '{"name":"adapter"}');
    const out = path.join(root, 'out');
    exportFrozenRuntime(workspace, out, ['api'], path.join(workspace, 'pnpm-lock.yaml'), { sharedDependencies });
    const modules = path.join(out, sharedDependencies ? 'dependencies' : 'api/node_modules');
    assert.ok(fs.existsSync(path.join(modules, '@anthropic-ai/claude-agent-sdk/sdk.mjs')));
    assert.ok(fs.existsSync(path.join(modules, 'sharp/sharp.node')));
    const files = fs.readdirSync(out, { recursive: true }).map(String);
    assert.deepEqual(
      files.filter((name) => /claude-agent-sdk-(win32|darwin|linux)/.test(name)),
      [],
    );
  });

test('archive rejects retained Claude native packages from an old deployment', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const native = path.join(source, '@anthropic-ai/claude-agent-sdk-win32-x64');
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, 'claude.exe'), 'retained-old-native-program');
  await assert.rejects(createRuntimeArchive(source, path.join(root, 'out.tar.gz')), /Claude.*external/i);
});
