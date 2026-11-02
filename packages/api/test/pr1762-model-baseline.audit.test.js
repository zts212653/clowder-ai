import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySessionConfiguration as before } from '../artifacts/pr1762-base-session-configuration.mts';
import { applySessionConfiguration as after } from '../dist/domains/cats/services/agents/providers/acp/session-configuration.js';

test('legacy model-only session rejects an explicit model before and after PR1762', async () => {
  const session = { sessionId: 'synthetic', models: { currentModelId: 'fixture-model' } };
  const client = { async setSessionConfigOption() { assert.fail('legacy client has no configurable model'); } };
  for (const configure of [before, after]) {
    await assert.rejects(configure(client, session, { model: 'fixture-model' }), /ACP 未提供 model 配置选项/);
    assert.deepEqual(await configure(client, session, {}), session);
  }
});
