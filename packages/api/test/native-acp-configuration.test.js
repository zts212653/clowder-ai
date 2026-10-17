import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  applySessionConfiguration,
  resolveSessionOption,
} from '../dist/domains/cats/services/agents/providers/acp/session-configuration.js';

const flash = '["official","flash"]';
const pro = '["official","pro"]';
const model = (value = flash) => ({
  id: 'model',
  category: 'model',
  currentValue: value,
  options: [
    {
      name: 'Official',
      options: [
        { value: flash, name: 'Flash' },
        { value: pro, name: 'Pro' },
      ],
    },
  ],
});
const effort = (value = 'high', options = ['off', 'low', 'high', 'max']) => ({
  id: 'reasoning_effort',
  category: 'thought_level',
  currentValue: value,
  options: options.map((value) => ({ value })),
});
it('maps unique legacy model ids to advertised opaque values', () => {
  assert.deepEqual(resolveSessionOption({ configOptions: [model()] }, 'model', 'pro'), {
    configId: 'model',
    value: pro,
    unchanged: false,
  });
});
it('rejects ambiguous models without guessing provider identity', () => {
  const descriptor = model();
  descriptor.options.push({ options: [{ value: '["proxy","pro"]' }] });
  assert.throws(() => resolveSessionOption({ configOptions: [descriptor] }, 'model', 'pro'), /不唯一/);
});
it('applies model then effort using the returned capability set', async () => {
  const requests = [];
  const client = {
    async setSessionConfigOption(id, configId, value) {
      requests.push({ id, configId, value });
      return { configOptions: [model(pro), effort(configId === 'model' ? 'high' : value)] };
    },
  };
  await applySessionConfiguration(
    client,
    { sessionId: 'resume', configOptions: [model(), effort()] },
    { model: 'pro', effort: 'low' },
  );
  assert.deepEqual(requests, [
    { id: 'resume', configId: 'model', value: pro },
    { id: 'resume', configId: 'reasoning_effort', value: 'low' },
  ]);
});
it('fails before a prompt if model change removes the requested effort', async () => {
  await assert.rejects(
    () =>
      applySessionConfiguration(
        {
          async setSessionConfigOption() {
            return { configOptions: [model(pro), effort('high', ['high'])] };
          },
        },
        { sessionId: 'new', configOptions: [model(), effort()] },
        { model: 'pro', effort: 'low' },
      ),
    /选项无效/,
  );
});
it('inherits native defaults without setting either option', async () => {
  await applySessionConfiguration(
    {
      async setSessionConfigOption() {
        throw Error('must not override');
      },
    },
    { sessionId: 'new' },
    {},
  );
});
it('requires confirmation of the adopted value', async () => {
  await assert.rejects(
    () =>
      applySessionConfiguration(
        {
          async setSessionConfigOption() {
            return { configOptions: [model()] };
          },
        },
        { sessionId: 'new', configOptions: [model()] },
        { model: 'pro' },
      ),
    /未采用/,
  );
});
