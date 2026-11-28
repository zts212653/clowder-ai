import assert from 'node:assert/strict';
import { test } from 'node:test';
import entrypoint from '../src/entrypoint.js';

const stop = () => {
  throw new Error('unexpected catalog port');
};
const base = { launch: stop, readClaude: stop, describeAcp: stop, selectAcpModel: stop };
const discovery = entrypoint.create().start({ agentAccess: {} as never }).actions.discoverModelCatalog;

test('the real entrypoint validates the Codex request envelope and calls only the Codex port', async () => {
  const result = await discovery({
    ...base,
    input: { operation: 'discover_model_catalog', client: 'codex', input: {} },
    launch: async (request) => {
      assert.deepEqual(request, { args: ['debug', 'models'] });
      return { stdout: JSON.stringify({ models: [{ slug: 'model-a', visibility: 'list' }] }) };
    },
  });
  assert.deepEqual(result.models, [{ value: 'model-a', label: 'model-a' }]);
});

test('Claude preserves configured defaults when live SDK discovery is unavailable', async () => {
  const result = await discovery({
    ...base,
    input: { operation: 'discover_model_catalog', client: 'claude', input: { model: 'secondary' } },
    readClaude: async () => ({
      models: [],
      settings: {
        model: 'primary',
        modelSettings: { primary: { effortLevel: 'high' }, secondary: { effortLevel: 'low' } },
      },
    }),
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.defaultModel, 'primary');
  assert.equal(result.defaultEffort, 'high');
  assert.equal(result.selectedEffort, 'low');
});

test('ACP projects defaults and only selects a model explicitly advertised by the session', async () => {
  const session = (model: string, effort: string) => ({
    configOptions: [
      {
        id: 'model',
        category: 'model',
        currentValue: model,
        options: [
          {
            name: 'Vendor',
            options: [
              { value: 'primary', name: 'A' },
              { value: 'secondary', name: 'B' },
            ],
          },
        ],
      },
      {
        id: 'reasoning_effort',
        currentValue: effort,
        options: [
          { value: 'high', name: 'High' },
          { value: 'low', name: 'Low' },
        ],
      },
    ],
  });
  let calls = 0;
  const discover = (model: string) =>
    discovery({
      ...base,
      input: { operation: 'discover_model_catalog', client: 'acp', input: { model } },
      describeAcp: async () => session('primary', 'high'),
      selectAcpModel: async (selected) => {
        calls++;
        assert.equal(selected, 'secondary');
        return session(selected, 'low');
      },
    });
  const live = await discover('secondary');
  assert.equal(live.defaultModelLabel, 'Vendor / A');
  assert.equal(live.selectedModel, 'secondary');
  assert.equal(live.selectedEffort, 'low');
  const custom = await discover('old-alias');
  assert.equal(custom.message, 'custom_model');
  assert.equal(custom.effortOptions, undefined);
  assert.equal(calls, 1);
});
