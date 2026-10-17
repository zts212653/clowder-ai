import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverDshRuntime } from '../src/routes/native-dsh-discovery.js';

test('fresh catalog can discover an existing DSH npx installation and ACP profile without creating a member', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-discovery-'));
  const dshHome = join(root, '.dsh');
  const cache = join(root, 'npm-cache');
  const pkg = join(cache, '_npx', 'cached', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(dshHome, 'profiles/acp'), { recursive: true });
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }));
  writeFileSync(join(pkg, 'lib/bin.js'), '');
  const options = { dshHome, npmCaches: [cache], resolveCommand: () => null };
  assert.equal(discoverDshRuntime(options).installed, false);
  writeFileSync(
    join(dshHome, 'profiles/acp/package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
  );
  const runtime = discoverDshRuntime(options);
  assert.equal(runtime.installed, true);
  assert.deepEqual(runtime.acp?.startupArgs, [join(pkg, 'lib/bin.js'), '--profile', 'acp']);
  assert.equal(runtime.command, process.execPath);
});
