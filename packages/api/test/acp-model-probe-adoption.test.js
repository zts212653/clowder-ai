import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { probeRuntimeCatalog } from '../dist/routes/runtime-catalog-probe.js';

const agent = fileURLToPath(new URL('./fixtures/plugin-acp-catalog-agent.mjs', import.meta.url));
test('model discovery reports only an observed selection and sends no prompt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'acp-model-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trace = join(root, 'trace.jsonl');
  const target = { kind: 'acp', command: process.execPath, args: [agent, trace], cwd: root, model: 'model-b' };
  const result = await probeRuntimeCatalog(target);
  assert.equal(result.selectedModel, 'model-b');
  assert.equal(result.defaultModel, 'model-a');
  const messages = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    messages.map((m) => m.method),
    ['initialize', 'session/new', 'session/set_config_option'],
  );
  assert.deepEqual(messages[1].params.mcpServers, []);
  await assert.rejects(probeRuntimeCatalog({ ...target, args: [agent, trace, '--ignore-selection'] }), /未采用/);
  assert.equal(result.defaultModelStatus, 'reported');
});
