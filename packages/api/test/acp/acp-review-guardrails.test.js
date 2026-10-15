import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import {
  createAcpSessionState,
  transformAcpEvent,
} from '../../dist/domains/cats/services/agents/providers/acp/acp-event-transformer.js';
import { imageFixture } from '../helpers/acp-image-fixture.js';

const metadata = { provider: 'fixture', model: 'fixture' };
for (const transport of ['stdio', 'http'])
  test(`${transport}: pending close blocks new prompt and coalesces concurrent close`, async () => {
    let release;
    const pause = new Promise((resolve) => {
      release = resolve;
    });
    const f = await imageFixture(transport, '/fixture', {
      initializeResult: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
      beforeResponse: (msg) => (msg.method === 'session/close' ? pause : undefined),
    });
    try {
      const closing = f.client.closeSession('native');
      const concurrent = f.client.closeSession('native');
      for (let i = 0; i < 100 && !f.captured.some((p) => p.method === 'session/close'); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      await assert.rejects(async () => {
        for await (const _ of f.client.promptStream('native', 'Synthetic')) {
        }
      }, /closed|retired/);
      if (transport === 'stdio') await assert.rejects(f.client.promptCollect('native', 'Synthetic'), /closed|retired/);
      assert.equal(f.captured.filter((p) => p.method === 'session/prompt').length, 0);
      assert.equal(f.captured.filter((p) => p.method === 'session/close').length, 1);
      release();
      await Promise.all([closing, concurrent]);
      for await (const _ of f.client.promptStream('other-native', 'Synthetic')) {
      }
      assert.equal(f.captured.filter((p) => p.method === 'session/prompt').length, 1);
    } finally {
      release();
      await f.close();
    }
  });
test('actual Claude bridge parent metadata survives ACP intake and scopes snapshot/final dedup', () => {
  const state = createAcpSessionState();
  const emit = (parent, status, path) =>
    transformAcpEvent(
      {
        sessionId: 'native',
        update: {
          sessionUpdate: status === 'pending' ? 'tool_call' : 'tool_call_update',
          toolCallId: 'same-native',
          name: 'Read',
          status,
          rawInput: { path },
          ...(parent ? { _meta: { claudeCode: { parentToolUseId: parent } } } : {}),
        },
      },
      'codex',
      metadata,
      state,
    );
  const root = emit(null, 'pending', 'root');
  const child = emit('parent-native', 'pending', 'child');
  assert.equal(root.toolUseId, child.toolUseId);
  assert.equal(child.toolParentUseId, 'parent-native');
  assert.equal(emit(null, 'completed', 'root-final').toolInput.path, 'root-final');
  const final = emit('parent-native', 'failed', 'child-final');
  assert.equal(final.toolParentUseId, 'parent-native');
  assert.equal(final.toolInput.path, 'child-final');
  assert.equal(final.toolResultStatus, 'error');
  assert.equal(emit('parent-native', 'failed', 'child-final'), null);
});
for (const transport of ['stdio', 'http'])
  for (const instruction of [undefined, '', '   '])
    test(`${transport}: required empty instruction (${String(instruction)}) cannot degrade to legacy prompt`, async () => {
      const f = await imageFixture(transport, '/fixture');
      let acquireCount = 0;
      try {
        const service = new AcpAgentService({
          catId: 'codex',
          projectRoot: '/fixture',
          mcpSupport: false,
          executionRequirements: { trustedInstructions: true },
          poolKey: { projectPath: '/fixture', providerProfile: 'fixture' },
          pool: {
            async acquire() {
              acquireCount++;
              return { client: f.client, release() {} };
            },
          },
        });
        const events = [];
        for await (const event of service.invoke('Synthetic prompt', { systemPrompt: instruction })) events.push(event);
        assert.equal(events.find((e) => e.type === 'error')?.errorCode, 'trusted_instructions_missing');
        assert.equal(acquireCount, 0);
        assert.equal(f.captured.filter((p) => p.method.startsWith('session/')).length, 0);
      } finally {
        await f.close();
      }
    });
