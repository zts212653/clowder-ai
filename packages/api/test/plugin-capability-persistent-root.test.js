import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDormantPluginRuntimeComposition } from '../dist/domains/plugin/runtime-composition.js';

test('plugin capability authority follows the invocation root without moving runtime inventory or configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-persistent-capability-root-'));
  const runtimeRoot = join(directory, 'runtime'),
    homeRoot = join(directory, 'home');
  const config = (id) => ({
    version: 2,
    capabilities: [
      {
        id,
        type: 'mcp',
        source: 'external',
        enabled: true,
        mcpServer: { command: '/usr/bin/true', args: [], transport: 'stdio' },
      },
    ],
  });
  try {
    for (const [root, id] of [
      [runtimeRoot, 'wrong-runtime-only'],
      [homeRoot, 'canonical-home'],
    ]) {
      await mkdir(join(root, '.cat-cafe'), { recursive: true });
      await writeFile(join(root, '.cat-cafe', 'capabilities.json'), JSON.stringify(config(id)));
    }
    const runtime = createDormantPluginRuntimeComposition({
      projectRoot: runtimeRoot,
      capabilityProjectRoot: homeRoot,
      messageStore: {},
    });
    const selected = await runtime.mcpConfigIO.readConfig();
    assert.deepEqual(
      selected.capabilities.map((x) => x.id),
      ['canonical-home'],
    );
    assert.equal(runtime.projectRoot, runtimeRoot);
    const normal = createDormantPluginRuntimeComposition({ projectRoot: runtimeRoot, messageStore: {} });
    assert.deepEqual(
      (await normal.mcpConfigIO.readConfig()).capabilities.map((x) => x.id),
      ['wrong-runtime-only'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
