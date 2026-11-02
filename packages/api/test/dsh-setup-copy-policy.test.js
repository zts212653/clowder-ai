import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { buildDshPatch } from '../dist/routes/dsh-setup-config.js';

const route = {
  api: 'openai-completions',
  baseURL: 'https://gateway.example/v1',
  apiKeyEnv: 'SAFE_REF',
  models: [{ id: 'model' }],
};
const source = (profile) => stringify([{ id: 'llm-pi-ai', config: { providers: { custom: profile } } }]);
const active = (profile) =>
  stringify([
    { id: 'llm-pi-ai', config: { providers: { retained: profile } } },
    { id: 'acp', config: { provider: 'deepseek-official', model: 'official' } },
  ]);
const cases = [
  ['custom authentication header', { ...route, headers: { 'X-Auth-Token': 'synthetic-inline-value' } }],
  ['arbitrary header spelling', { ...route, headers: { 'X-Tenant-Pass': 'synthetic-inline-value' } }],
  ['model header', { ...route, models: [{ id: 'model', headers: { 'X-Custom': 'synthetic-inline-value' } }] }],
  ['unknown provider extension', { ...route, extensions: { proof: 'synthetic-inline-value' } }],
  ['unknown compatibility extension', { ...route, compat: { extra: { proof: 'synthetic-inline-value' } } }],
  ['non-reference credential name', { ...route, apiKeyEnv: { value: 'synthetic-inline-value' } }],
  ['custom URL query name', { ...route, baseURL: 'https://gateway.example/v1?signature=synthetic-inline-value' }],
];
for (const [name, profile] of cases) {
  test(`rejects ${name} in selected source before producing a persistent patch`, () => {
    assert.throws(
      () => buildDshPatch(active(route), source(profile), 'custom', 'model'),
      /dsh_.*(?:manual|credential)/,
    );
  });
  test(`rejects ${name} in retained active providers without dropping that provider`, () => {
    assert.throws(
      () => buildDshPatch(active(profile), source(route), 'custom', 'model'),
      /dsh_.*(?:manual|credential)/,
    );
  });
}
test('preserves supported metadata and credential references byte-for-value', () => {
  const supported = {
    ...route,
    headers: {},
    defaultContextWindow: 131072,
    defaultMaxTokens: 4096,
    models: [
      {
        id: 'model',
        name: 'Gateway',
        contextWindow: 131072,
        maxTokens: 4096,
        input: ['text'],
        reasoningEfforts: { off: null, high: 'high' },
        compat: { supportsStore: false },
      },
    ],
    thinkingBudgets: { low: 1024, medium: 2048, high: 4096 },
    retryPolicy: { mode: 'normal', maxRetries: 0 },
  };
  const result = parse(buildDshPatch(active(route), source(supported), 'custom', 'model'));
  assert.deepEqual(result[0].config.providers.custom, supported);
  assert.deepEqual(result[0].config.providers.retained, route);
});
for (const id of ['llm-pi-ai', 'acp']) {
  test(`rejects unsupported ${id} plugin fields before copying the whole config`, () => {
    const entries = parse(active(route));
    entries.find((entry) => entry.id === id).config.extension = { header: 'synthetic-inline-value' };
    assert.throws(() => buildDshPatch(stringify(entries), source(route), 'custom', 'model'), /dsh_config_manual/);
  });
}
test('does not copy or reject an unselected source provider that contains custom headers', () => {
  const entries = parse(source(route));
  entries[0].config.providers.unselected = { ...route, headers: { 'X-Private': 'synthetic-inline-value' } };
  const result = parse(buildDshPatch(active(route), stringify(entries), 'custom', 'model'));
  assert.deepEqual(Object.keys(result[0].config.providers), ['retained', 'custom']);
});
