import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { AccountConfig } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { resolveForClient, resolveOpenAIPlatformAccount } from '../src/config/account-resolver.js';
import { createOpenAIPlatformClient } from '../src/domains/services/openai-platform/client.js';
import { accountsRoutes } from '../src/routes/accounts.js';

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openai-platform-'));
  previousRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  mkdirSync(join(root, '.cat-cafe'));
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});
function store(accounts: Record<string, AccountConfig>, keys: Record<string, string> = {}) {
  writeFileSync(join(root, '.cat-cafe/accounts.json'), JSON.stringify(accounts));
  writeFileSync(
    join(root, '.cat-cafe/credentials.json'),
    JSON.stringify(Object.fromEntries(Object.entries(keys).map(([id, apiKey]) => [id, { apiKey }]))),
  );
}
const platform = { authType: 'api_key', clientId: 'openai' } as const;
const request = {
  model: 'gpt-6-luna',
  input: 'fixture',
  questions: [
    { type: 'choice' as const, name: 'target', instructions: 'Choose', choices: [{ value: 'C0' }, { value: 'ASK' }] },
    { type: 'score' as const, name: 'priority', instructions: 'Rate', levels: [{ label: 'low' }, { label: 'high' }] },
  ],
};
const answer = () =>
  Response.json(
    {
      model: 'gpt-6-luna',
      answers: [
        { type: 'choice', name: 'target', choice: 'C0', confidence: 0.9 },
        { type: 'score', name: 'priority', score: 0.7, confidence: 0.8 },
      ],
    },
    { headers: { 'x-request-id': 'fixture-provider-id' } },
  );

test('named Platform accounts resolve without changing the Codex OAuth runtime binding', () => {
  store({ codex: { authType: 'oauth', clientId: 'openai' }, 'my-platform': platform }, { 'my-platform': 'FAKE_KEY' });
  assert.equal(resolveOpenAIPlatformAccount(root)?.id, 'my-platform');
  assert.equal(resolveOpenAIPlatformAccount(root, 'my-platform')?.apiKey, 'FAKE_KEY');
  assert.equal(resolveForClient(root, 'openai', 'codex')?.authType, 'oauth');
  assert.throws(() => resolveOpenAIPlatformAccount(root, 'codex'), /OpenAI Platform/);
  assert.throws(() => resolveOpenAIPlatformAccount(root, 'missing'), /OpenAI Platform/);
});
test('auto discovery rejects ambiguity and explicit foreign or empty credentials, with no synthetic fallback', () => {
  store(
    { first: platform, second: platform, empty: platform, foreign: { authType: 'api_key', clientId: 'kimi' } },
    { first: 'FAKE_A', second: 'FAKE_B', foreign: 'FAKE_C' },
  );
  assert.throws(() => resolveOpenAIPlatformAccount(root), /multiple|Multiple/);
  assert.equal(resolveOpenAIPlatformAccount(root, 'second')?.id, 'second');
  for (const ref of ['foreign', 'empty']) assert.throws(() => resolveOpenAIPlatformAccount(root, ref));
  store({ codex: { authType: 'oauth', clientId: 'openai' } });
  assert.equal(resolveOpenAIPlatformAccount(root), undefined);
});
test('account route persists name and key alone and does not expose key or mutate an existing login', async () => {
  store({ codex: { authType: 'oauth', clientId: 'openai' } });
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root, displayName: 'Platform', ...platform, apiKey: 'FAKE_KEY' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const profile = response.json().profile;
    assert.equal(profile.hasApiKey, true);
    assert.equal(response.body.includes('FAKE_KEY'), false);
    assert.equal(resolveOpenAIPlatformAccount(root)?.id, profile.id);
    assert.equal(resolveForClient(root, 'openai', 'codex')?.authType, 'oauth');
  } finally {
    await app.close();
  }
});
test('automatic selection excludes gateways and insecure official URLs; explicit gateway selection remains available', () => {
  const gateway = { ...platform, baseUrl: 'https://gateway.invalid/v1' };
  store({ gateway }, { gateway: 'FAKE_GATEWAY_KEY' });
  assert.equal(resolveOpenAIPlatformAccount(root), undefined);
  assert.equal(resolveOpenAIPlatformAccount(root, 'gateway')?.id, 'gateway');
  store(
    { gateway, official: { ...platform, baseUrl: 'https://api.openai.com/v1' } },
    { gateway: 'FAKE_GATEWAY_KEY', official: 'FAKE_OFFICIAL_KEY' },
  );
  assert.equal(resolveOpenAIPlatformAccount(root)?.id, 'official');
  store({ insecure: { ...platform, baseUrl: 'http://api.openai.com' } }, { insecure: 'FAKE_INSECURE_KEY' });
  assert.equal(resolveOpenAIPlatformAccount(root), undefined);
});
test('Decisions uses the same account, caller model and object choices/levels; credentials refresh per call', async () => {
  store({ platform }, { platform: 'FAKE_KEY' });
  const seen: string[] = [];
  const client = createOpenAIPlatformClient({
    projectRoot: root,
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/decisions');
      assert.equal(init?.redirect, 'error');
      const authorization = new Headers(init?.headers).get('authorization');
      assert.ok(authorization);
      seen.push(authorization);
      assert.deepEqual(JSON.parse(String(init?.body)), request);
      return answer();
    },
  });
  const result = await client.decide(request);
  assert.equal(result.answers[0].type, 'choice');
  assert.equal(result.accountRef, 'platform');
  assert.equal(result.providerRequestId, 'fixture-provider-id');
  store({ platform }, { platform: 'FAKE_REPLACEMENT' });
  await client.decide(request);
  assert.deepEqual(seen, ['Bearer FAKE_KEY', 'Bearer FAKE_REPLACEMENT']);
});
test('configured gateway is honored; official-provider mismatch is rejected before sending', async () => {
  let calls = 0;
  const client = createOpenAIPlatformClient({
    projectRoot: root,
    accountRef: 'platform',
    fetch: async (url) => {
      calls++;
      assert.equal(url, 'https://gateway.invalid/v1/decisions');
      return answer();
    },
  });
  store({ platform: { ...platform, baseUrl: 'https://gateway.invalid/v1/' } }, { platform: 'FAKE_KEY' });
  await client.decide(request);
  store({ platform: { ...platform, baseUrl: 'https://api.anthropic.com' } }, { platform: 'FAKE_KEY' });
  await assert.rejects(client.decide(request));
  assert.equal(calls, 1);
});
test('Decisions shares official-host normalization and does not restrict the requested model to account models', async () => {
  store({ platform: { ...platform, baseUrl: 'api.openai.com', models: ['gpt-6'] } }, { platform: 'FAKE_KEY' });
  const client = createOpenAIPlatformClient({
    projectRoot: root,
    accountRef: 'platform',
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/decisions');
      assert.equal(JSON.parse(String(init?.body)).model, 'gpt-6-luna');
      return answer();
    },
  });
  assert.equal((await client.decide(request)).accountRef, 'platform');
});
test('cancellation, HTTP errors, malformed answers and oversized bodies remain unconfirmed without leaking secrets', async () => {
  store({ platform }, { platform: 'FAKE_KEY' });
  let calls = 0;
  const client = createOpenAIPlatformClient({
    projectRoot: root,
    fetch: async () => {
      calls++;
      return answer();
    },
  });
  await assert.rejects(client.decide(request, { signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
  for (const response of [
    new Response('FAKE_KEY', { status: 401 }),
    Response.json({ answers: [] }),
    Response.json({
      model: 'gpt-6-luna',
      answers: [
        { name: 'target', type: 'choice', choice: 'invented', confidence: 1 },
        { name: 'priority', type: 'score', score: 0.7, confidence: 0.8 },
      ],
    }),
    new Response('x'.repeat(1_048_577)),
  ]) {
    await assert.rejects(
      createOpenAIPlatformClient({ projectRoot: root, fetch: async () => response }).decide(request),
      (error: Error) => !error.message.includes('FAKE_KEY'),
    );
  }
});

test('answer names and types stay bound to the request; refusal is a typed result and in-flight abort wins', async () => {
  store({ platform }, { platform: 'FAKE_KEY' });
  for (const answers of [
    [
      { type: 'choice', name: 'target', choice: 'C0', confidence: 0.9 },
      { type: 'choice', name: 'target', choice: 'C0', confidence: 0.9 },
    ],
    [
      { type: 'score', name: 'target', score: 0.7, confidence: 0.9 },
      { type: 'score', name: 'priority', score: 0.7, confidence: 0.9 },
    ],
    [
      { type: 'choice', name: 'target', choice: 'C0', confidence: 0.9 },
      { type: 'score', name: 'priority', score: 7, confidence: 0.9 },
    ],
  ]) {
    await assert.rejects(
      createOpenAIPlatformClient({
        projectRoot: root,
        fetch: async () => Response.json({ model: 'gpt-6-luna', answers }),
      }).decide(request),
    );
  }
  const refused = await createOpenAIPlatformClient({
    projectRoot: root,
    fetch: async () =>
      Response.json({
        model: 'gpt-6-luna',
        answers: request.questions.map((q) => ({ name: q.name, type: 'refusal' })),
      }),
  }).decide(request);
  assert.ok(refused.answers.every((answer) => answer.type === 'refusal'));
  const controller = new AbortController();
  const client = createOpenAIPlatformClient({
    projectRoot: root,
    fetch: async () => {
      controller.abort();
      return answer();
    },
  });
  await assert.rejects(client.decide(request, { signal: controller.signal }));
});
