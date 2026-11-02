import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { buildDshPatch, composeDshProviderSource, inspectDshConfig } from '../dist/routes/dsh-setup-config.js';

const active = stringify([
  { id: 'llm-pi-ai', config: { providers: { retained: { models: [{ id: 'old' }] } } } },
  { id: 'acp', config: { provider: 'deepseek-official', model: 'official', sessionListPageSize: 123 } },
  { id: 'unrelated', config: { value: 'preserve elsewhere' } },
]);
const provider = {
  api: 'openai-completions',
  baseURL: 'https://gateway.example/v1',
  apiKeyEnv: 'CUSTOM_KEY',
  compat: { supportsStore: false },
  models: [{ id: 'model/a', contextWindow: 131072, maxTokens: 4096 }],
};
const source = stringify([{ id: 'llm-pi-ai', config: { providers: { custom: provider } } }]);

test('custom-only route is advertised without requiring an official provider or credential', () => {
  assert.deepEqual(inspectDshConfig(source), {
    providers: [{ id: 'custom', models: [{ id: 'model/a', label: 'model/a' }] }],
    provider: undefined,
    model: undefined,
  });
});
test('Desktop provider source respects complete home config replacement, including an empty provider dict', () => {
  assert.equal(inspectDshConfig(composeDshProviderSource(source, '[]')).providers[0]?.id, 'custom');
  assert.deepEqual(
    inspectDshConfig(composeDshProviderSource(source, '- id: llm-pi-ai\n  config:\n    providers: {}\n')).providers,
    [],
  );
});
test('overlay copies the complete custom route, preserves active config, and selects the opaque tuple', () => {
  const patch = parse(buildDshPatch(active, source, 'custom', 'model/a'));
  assert.equal(patch.length, 2);
  assert.deepEqual(patch[0], {
    id: 'llm-pi-ai',
    config: {
      providers: {
        retained: { models: [{ id: 'old' }] },
        custom: provider,
      },
    },
  });
  assert.deepEqual(patch[1], { id: 'acp', config: { provider: 'custom', model: 'model/a', sessionListPageSize: 123 } });
  assert.equal(parse(active)[1].config.provider, 'deepseek-official');
});
test('refuses unknown route/model and ambiguous plugin IDs instead of falling back to official', () => {
  assert.throws(() => buildDshPatch(active, source, 'absent', 'model/a'), /selection/);
  assert.throws(() => buildDshPatch(active, source, 'custom', 'absent'), /selection/);
  assert.throws(() => inspectDshConfig(`${source}\n- id: llm-pi-ai\n  config: {}\n`), /ambiguous/);
  assert.throws(() => composeDshProviderSource(`${source}\n- insert: []\n`, '[]'), /complex_patch/);
});
test('never copies inline keys or evaluates custom YAML expressions', () => {
  const secret = source.replace('apiKeyEnv: CUSTOM_KEY', 'apiKey: private-value');
  assert.throws(() => buildDshPatch(active, secret, 'custom', 'model/a'), /dsh_config_manual/);
  assert.throws(
    () => buildDshPatch(active, source.replace('CUSTOM_KEY', '!!js dangerous()'), 'custom', 'model/a'),
    /expression/,
  );
  const harmlessUnrelated = `${active}\n- id: native-persistence\n  config:\n    path: !!js dshHomePath('sessions')\n`;
  assert.equal(parse(buildDshPatch(harmlessUnrelated, source, 'custom', 'model/a'))[1].config.model, 'model/a');
});
