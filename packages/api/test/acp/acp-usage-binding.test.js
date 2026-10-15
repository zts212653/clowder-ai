import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpPromptUsageTracker } from '../../dist/domains/cats/services/agents/providers/acp/protocol/acp-usage.js';
import { imageFixture } from '../helpers/acp-image-fixture.js';

const NS = 'clowder.ai/acp.v1';
const result = (usage) => ({
  stopReason: 'end_turn',
  ...(usage ? { usage } : {}),
  _meta: { [NS]: { usage: { scope: 'prompt', kind: 'snapshot' } } },
});
for (const transport of ['stdio', 'http'])
  for (const usage of [undefined, { outputTokens: 2 }])
    test(`${transport}: replacement usage (${JSON.stringify(usage)}) cannot inherit another session snapshot`, async () => {
      const a = result({ inputTokens: 10, outputTokens: 1 });
      const b = result(usage);
      const f = await imageFixture(transport, '/fixture', {
        resumeEmpty: true,
        initializeResult: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, _meta: { [NS]: { contractVersion: 1, usage: { scope: 'prompt' } } } },
        },
        promptResult: (msg) => (msg.params.sessionId === 'existing' ? a : b),
      });
      try {
        const svc = new AcpAgentService({
          catId: 'codex',
          projectRoot: '/fixture',
          mcpSupport: false,
          poolKey: { projectPath: '/fixture', providerProfile: 'fixture' },
          pool: {
            async acquire() {
              return { client: f.client, release() {} };
            },
            rememberSession() {},
          },
        });
        const events = [];
        for await (const event of svc.invoke('Synthetic prompt', { sessionId: 'existing' })) events.push(event);
        const done = events.findLast((e) => e.type === 'done');
        assert.deepEqual(done.metadata.usage, usage);
        assert.notEqual(done.metadata.sessionId, 'existing');
        assert.deepEqual(
          done.metadata.diagnostics.acpPromptReceipts.map((r) => r.result),
          [a, b],
        );
      } finally {
        await f.close();
      }
    });
test('partial prompt snapshot replaces old fields within the same session', () => {
  const tracker = new AcpPromptUsageTracker();
  tracker.bind('native', true);
  assert.deepEqual(tracker.accept(result({ inputTokens: 10, outputTokens: 1 })).usage, {
    inputTokens: 10,
    outputTokens: 1,
  });
  assert.deepEqual(tracker.accept(result({ outputTokens: 2 })).usage, { outputTokens: 2 });
});
