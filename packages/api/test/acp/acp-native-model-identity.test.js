import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';

test('native ACP adopts the model reported by the first session for message metadata', async () => {
  catRegistry.reset();
  catRegistry.register('pi', {
    id: 'pi',
    clientId: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '',
  });
  const client = {
    async newSession() {
      return {
        sessionId: 'pi-session',
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: '["openai","gpt-5.4"]',
            options: [{ value: '["openai","gpt-5.4"]' }],
          },
        ],
      };
    },
    async setSessionConfigOption() {},
    async *promptStream() {
      yield {
        sessionId: 'pi-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
      };
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
  };
  const pool = {
    async acquire() {
      return { client, poolKey: { projectPath: '/tmp', providerProfile: 'pi' }, release() {} };
    },
  };
  const service = new AcpAgentService({
    catId: 'pi',
    pool,
    poolKey: { projectPath: '/tmp', providerProfile: 'pi' },
    projectRoot: '/tmp',
    providerName: 'acp',
    modelName: 'acp',
  });
  const messages = [];
  for await (const message of service.invoke('hello')) messages.push(message);
  assert.equal(messages.find((message) => message.type === 'text')?.metadata?.model, '["openai","gpt-5.4"]');
});
