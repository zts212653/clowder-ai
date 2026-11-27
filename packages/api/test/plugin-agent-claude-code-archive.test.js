import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setup } from './helpers/agent-adapter-archive.js';

const archive = process.env.CLOWDER_CLAUDE_CANDIDATE_ARCHIVE;

test('Host Manager installs and loads the independent Claude Code archive', { skip: !archive }, async (t) => {
  const { runtime, manager } = await setup(t);
  const ref = { pluginId: 'official.agent-claude-code', contributionId: 'claude-code' };
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
  const { plugin: enabled } = await manager.get(ref.pluginId);
  await manager.setEnabled(ref.pluginId, { enabled: false, expectedRevision: enabled.lifecycleRevision });
  await assert.rejects(runtime.agentAdapters.describe(ref));
});
