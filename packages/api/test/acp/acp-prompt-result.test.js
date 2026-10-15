import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { imageFixture } from '../helpers/acp-image-fixture.js';

const root = await mkdtemp(join(tmpdir(), 'acp-prompt-result-'));
after(() => rm(root, { recursive: true, force: true }));

for (const transport of ['stdio', 'http']) {
  for (const stopReason of ['cancelled', 'refusal', 'max_tokens', 'max_turn_requests']) {
    test(`${transport}: native ${stopReason} with zero events does not retry empty resume`, async () => {
      const fixture = await imageFixture(transport, root, { resumeEmpty: true, promptResult: { stopReason } });
      try {
        const service = new AcpAgentService({
          catId: 'codex',
          providerName: 'fixture',
          modelName: 'fixture',
          projectRoot: root,
          poolKey: { projectPath: root, providerProfile: 'fixture' },
          mcpSupport: false,
          pool: {
            async acquire() {
              return { client: fixture.client, release() {} };
            },
            rememberSession() {},
          },
        });
        const events = [];
        for await (const event of service.invoke('Synthetic prompt only', { sessionId: 'existing' }))
          events.push(event);
        assert.equal(fixture.captured.filter((packet) => packet.method === 'session/prompt').length, 1);
        assert.equal(fixture.captured.filter((packet) => packet.method === 'session/new').length, 0);
        assert.equal(events.filter((event) => event.type === 'error')[0]?.errorCode, stopReason);
        assert.equal(events.filter((event) => event.type === 'done').length, 1);
        assert.equal(fixture.client.isSessionSafeForReuse('existing'), true);
      } finally {
        await fixture.close();
      }
    });
  }
  test(`${transport}: exposes the complete native result and keeps the existing generator return`, async () => {
    const result = {
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 7 },
      _meta: { fixture: 'raw-marker' },
      extra: 0,
    };
    const fixture = await imageFixture(transport, root, { promptResult: result });
    try {
      let receipt;
      const stream = fixture.client.promptStream('existing', 'Synthetic', {
        onResult(value) {
          receipt = value;
        },
      });
      let step;
      do {
        step = await stream.next();
      } while (!step.done);
      assert.equal(step.value, 'end_turn');
      assert.deepEqual(receipt, result);
    } finally {
      await fixture.close();
    }
  });
  test(`${transport}: missing native stop reason is a protocol failure`, async () => {
    const fixture = await imageFixture(transport, root, { promptResult: { _meta: { fixture: true } } });
    try {
      await assert.rejects(async () => {
        for await (const _event of fixture.client.promptStream('existing', 'Synthetic')) {
        }
      }, /stopReason/);
      assert.equal(fixture.client.isSessionSafeForReuse('existing'), false);
    } finally {
      await fixture.close();
    }
  });
}
test('stdio collect exposes the full native result', async () => {
  const result = { stopReason: 'end_turn', usage: { inputTokens: 5 }, _meta: { fixture: true } };
  const fixture = await imageFixture('stdio', root, { promptResult: result });
  try {
    assert.deepEqual((await fixture.client.promptCollect('existing', 'Synthetic')).result, result);
  } finally {
    await fixture.close();
  }
});
