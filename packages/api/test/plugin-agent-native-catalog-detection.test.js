import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createPluginManagerRuntimeComposition } from '../dist/domains/plugin/index.js';
import { setup } from './helpers/agent-adapter-archive.js';

const packages = [
  {
    id: 'kimi',
    name: 'Kimi Code',
    version: '0.1.0-alpha.2',
    archive: process.env.CLOWDER_KIMI_CANDIDATE_ARCHIVE,
  },
  {
    id: 'codex',
    name: 'Codex',
    version: '0.1.0-alpha.1',
    archive: process.env.CLOWDER_CODEX_CANDIDATE_ARCHIVE,
  },
];

for (const { id, name, version, archive } of packages) {
  test(
    `${name}: default Host detects a catalog install and denies the same locally uploaded bytes`,
    {
      skip: !archive,
      timeout: 45_000,
    },
    async (t) => {
      const ref = { pluginId: `official.agent-${id}`, contributionId: id };
      const bytes = await readFile(archive);
      const entry = {
        catalogId: `agent-${id}`,
        packageName: `@clowder-ai/agent-${id}`,
        version,
        pluginId: ref.pluginId,
        distribution: 'registry',
        archiveUrl: `https://registry.npmjs.org/@clowder-ai/agent-${id}/-/agent-${id}-${version}.tgz`,
        packageDigest: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      };
      const local = await setup(t);
      await local.manager.install({ source: { kind: 'local-archive', path: archive } });
      const { plugin: localPlugin } = await local.manager.get(ref.pluginId);
      await local.manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: localPlugin.lifecycleRevision });
      const localResult = await local.runtime.agentAdapters.detect(ref);
      assert.equal(localResult.binding.packageDigest, entry.packageDigest);
      assert.deepEqual(localResult.candidates[0]?.state, {
        status: 'unavailable',
        reason: 'native_runtime_port_unavailable',
      });

      const { runtime } = await setup(t);
      const { manager } = createPluginManagerRuntimeComposition({
        runtime,
        catalogManifests: [
          {
            pluginId: ref.pluginId,
            version,
            contractVersion: '0.4.0-candidate.0',
            name,
            features: [{ id, name, resources: [] }],
            runtime: { transport: 'builtin', entrypoint: 'src/index.mjs', dataDirectory: `agent-${id}` },
          },
        ],
        catalogProvider: { snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 0 }) },
        fetchOfficialArchive: async () => bytes,
        threads: { get: () => null },
      });
      await manager.install({
        source: { kind: 'catalog', catalogId: entry.catalogId },
        expectedVersion: entry.version,
        expectedDigest: entry.packageDigest,
      });
      const { plugin } = await manager.get(ref.pluginId);
      await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
      assert.equal(
        (await runtime.inventoryStore.readCurrentAuthority(ref.pluginId))?.packageRecord?.provenance?.kind,
        'catalog',
      );
      const result = await runtime.agentAdapters.detect(ref);
      assert.equal(result.binding.packageDigest, entry.packageDigest);
      assert.equal(result.candidates[0]?.state.status, 'ready', JSON.stringify(result.candidates[0]?.state));
      assert.match(result.candidates[0].state.version, /^\d+\.\d+\.\d+/);
      t.diagnostic(`Verified the native ${name} CLI version ${result.candidates[0].state.version}.`);
    },
  );
}
