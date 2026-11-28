import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setup } from './helpers/agent-adapter-archive.js';

const archives = [
  ['claude-code', process.env.CLOWDER_CLAUDE_CANDIDATE_ARCHIVE],
  ['agy', process.env.CLOWDER_AGY_CANDIDATE_ARCHIVE],
];

test(
  'Claude Code and AGY install together and deactivate independently',
  {
    skip: archives.some(([, path]) => !path),
  },
  async (t) => {
    const { runtime, manager } = await setup(t);
    const installed = [];
    for (const [id, archive] of archives) {
      const ref = { pluginId: `official.agent-${id}`, contributionId: id };
      const bytes = await readFile(archive);
      const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
      await manager.install({ source: { kind: 'local-archive', path: archive } });
      const { plugin } = await manager.get(ref.pluginId);
      assert.equal(plugin.packageDigest, digest);
      await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
      assert.equal((await runtime.agentAdapters.describe(ref)).capabilities.resume.status, 'supported');
      const { candidates, binding } = await runtime.agentAdapters.detect(ref);
      assert.equal(binding.packageDigest, digest);
      assert.deepEqual(candidates[0].state, { status: 'unavailable', reason: 'native_runtime_port_unavailable' });
      installed.push({ ref, binding });
    }

    const [claude, agy] = installed;
    assert.notEqual(claude.binding.pluginInstanceId, agy.binding.pluginInstanceId);
    const { plugin } = await manager.get(claude.ref.pluginId);
    await manager.setEnabled(claude.ref.pluginId, { enabled: false, expectedRevision: plugin.lifecycleRevision });
    await assert.rejects(runtime.agentAdapters.describe(claude.ref));
    assert.deepEqual((await runtime.agentAdapters.detect(agy.ref)).binding, agy.binding);
  },
);
