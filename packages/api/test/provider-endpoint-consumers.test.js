import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { CatAgentService } from '../dist/domains/cats/services/agents/providers/catagent/CatAgentService.js';
import { LlmAIProvider } from '../dist/domains/cats/services/game/LlmAIProvider.js';

let root;
let previousRoot;
let previousFetch;
let configs;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'endpoint-consumers-'));
  mkdirSync(join(root, '.cat-cafe'));
  previousRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  previousFetch = globalThis.fetch;
  configs = catRegistry.getAllConfigs();
  globalThis.fetch = async () => {
    throw new Error('unexpected fetch');
  };
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  if (previousRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousRoot;
  catRegistry.reset();
  for (const [id, config] of Object.entries(configs)) catRegistry.register(id, config);
  rmSync(root, { recursive: true, force: true });
});
const put = (filename, value) => writeFileSync(join(root, '.cat-cafe', filename), JSON.stringify(value));

for (const baseUrl of ['https://gateway.invalid/v1?tenant=a#part', 'file:///tmp/fixture']) {
  test(`real CatAgent invocation uses the endpoint boundary: ${baseUrl}`, async () => {
    put('accounts.json', { fixture: { authType: 'api_key', clientId: 'anthropic', baseUrl } });
    put('credentials.json', { fixture: { apiKey: 'FAKE' } });
    const service = new CatAgentService({ catId: 'opus', projectRoot: root, catConfig: { accountRef: 'fixture' } });
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(url);
      return new Response('fixture', { status: 401 });
    };
    for await (const _event of service.invoke('fixture')) {
      /* drain real path */
    }
    assert.deepEqual(urls, baseUrl.startsWith('file:') ? [] : ['https://gateway.invalid/v1/messages?tenant=a#part']);
  });
}

test('real Google game request encodes the complete key in one URL parameter', async () => {
  const key = 'FAKE&admin=yes+#?/';
  put('accounts.json', { gemini: { authType: 'oauth', clientId: 'google' } });
  put('credentials.json', { gemini: { apiKey: key } });
  catRegistry.register('endpoint-google', {
    ...configs.gemini,
    id: 'endpoint-google',
    clientId: 'google',
    accountRef: 'gemini',
    defaultModel: 'gemini-fixture',
    mentionPatterns: ['@endpoint-google'],
  });
  let actual;
  globalThis.fetch = async (url) => {
    actual = new URL(url);
    return Response.json({ candidates: [{ content: { parts: [{ text: 'fixture' }] } }] });
  };
  assert.equal(await new LlmAIProvider('endpoint-google').generateSpeech('fixture'), 'fixture');
  assert.deepEqual([...actual.searchParams], [['key', key]]);
  assert.equal(actual.hash, '');
});
