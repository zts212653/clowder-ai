import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { readConfiguredPageAction } from '../src/domains/concierge/action/jev/page-action-config.js';
import { readHomeJevSelector } from '../src/domains/concierge/live/host/home/home-jev-config.js';
import { platformHttpTransport } from '../src/domains/services/openai-platform/http-transport.js';

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'f317-openai-'));
  previousRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({ platform: { authType: 'api_key', clientId: 'openai' } }),
  );
  writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify({ platform: { apiKey: 'FAKE_KEY' } }));
});
afterEach(() => {
  mock.restoreAll();
  if (previousRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});
const env = {
  CAT_CAFE_PAGE_DECISION_PROVIDER: 'openai',
  OPENAI_PLATFORM_ACCOUNT_REF: 'platform',
  OPENAI_DECISIONS_MODEL: 'gpt-6-luna',
};
const candidates = [{ id: 'note', operation: 'fill' as const, label: '今日便签', fingerprint: 'PRIVATE_DOM' }];
const response = (target = 'C0', value = 'V0', confidence = 0.9) =>
  Response.json({
    model: 'gpt-6-luna',
    answers: [
      { type: 'choice', name: 'target', choice: target, confidence },
      { type: 'choice', name: 'value', choice: value, confidence: 0.9 },
    ],
  });

test('home composition selects through the named Platform account and records actual provider provenance', async () => {
  let body = '';
  mock.method(platformHttpTransport, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    body = String(init.body);
    return response();
  });
  const selector = await readHomeJevSelector(env);
  assert.ok(selector);
  const result = await selector.select({
    utterance: '把今日便签改成带伞',
    candidates,
    signal: new AbortController().signal,
  });
  assert.deepEqual(result.choice, { kind: 'act', targetId: 'note', operation: 'fill', value: '带伞' });
  assert.equal(result.receipt.requestedModel, 'gpt-6-luna');
  assert.equal(result.receipt.servedModel, 'gpt-6-luna');
  assert.equal(result.receipt.provider, 'openai');
  assert.equal(result.receipt.accountRef, 'platform');
  assert.equal(body.includes('PRIVATE_DOM'), false);
  assert.equal(body.includes('FAKE_KEY'), false);
  assert.deepEqual(JSON.parse(body).questions[0].choices[0], {
    value: 'C0',
    description: JSON.stringify({ operation: 'fill', label: '今日便签' }),
  });
});
test('ASK, NONE and low confidence cannot become an operation; explicit missing account never falls back to Jev', async () => {
  for (const [target, confidence, expected] of [
    ['ASK', 0.9, 'ask'],
    ['NONE', 0.9, 'none'],
    ['C0', 0.1, 'ask'],
  ] as const) {
    mock.method(platformHttpTransport, 'fetch', async () => response(target, 'V0', confidence));
    const selector = await readHomeJevSelector(env);
    assert.ok(selector);
    assert.equal(
      (await selector.select({ utterance: '改成「带伞」', candidates, signal: new AbortController().signal })).choice
        .kind,
      expected,
    );
    mock.restoreAll();
  }
  let calls = 0;
  mock.method(platformHttpTransport, 'fetch', async () => {
    calls++;
    return response();
  });
  const selector = await readHomeJevSelector({
    ...env,
    OPENAI_PLATFORM_ACCOUNT_REF: 'missing',
    TYPESAFE_API_KEY: 'FAKE_LEGACY',
  });
  assert.ok(selector);
  await assert.rejects(
    selector.select({ utterance: '改成「带伞」', candidates, signal: new AbortController().signal }),
  );
  assert.equal(calls, 0);
});
test('the configured page composition uses the same account and retains policy, consent and readback', async () => {
  const path = join(root, 'page.json');
  writeFileSync(
    path,
    JSON.stringify({
      profileId: 'owner-note',
      pageUrl: 'http://127.0.0.1:5261/',
      browserURL: 'http://127.0.0.1:5262',
      allowJevProjection: true,
      targets: [{ id: 'note', selector: '#note', operation: 'fill', expectedReadbackTemplate: '{value}' }],
      readback: { selector: '#note', kind: 'value' },
    }),
  );
  mock.method(platformHttpTransport, 'fetch', async () => response());
  const configured = await readConfiguredPageAction({ ...env, CAT_CAFE_JEV_PAGE_CONFIG: path });
  assert.ok(configured && 'profile' in configured);
  const plan = await configured.profile.prepare(
    { origin: 'http://127.0.0.1:5261', url: 'http://127.0.0.1:5261/', readback: '', candidates },
    { utterance: '改成「带伞」', signal: new AbortController().signal },
  );
  assert.equal(plan.action.expectedReadback, '带伞');
  assert.equal(plan.consent.value, '带伞');
  assert.equal(plan.selection?.requestedModel, 'gpt-6-luna');
});

test('startup reports a missing OpenAI account while retaining next-call discovery after configuration', async () => {
  writeFileSync(join(root, '.cat-cafe/accounts.json'), '{}');
  writeFileSync(join(root, '.cat-cafe/credentials.json'), '{}');
  let warnings = 0;
  const selector = await readHomeJevSelector(env, () => {
    warnings++;
  });
  assert.ok(selector);
  assert.equal(warnings, 1);
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({ platform: { clientId: 'openai', authType: 'api_key' } }),
  );
  writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify({ platform: { apiKey: 'FAKE_ADDED_LATER' } }));
  mock.method(platformHttpTransport, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer FAKE_ADDED_LATER');
    return response();
  });
  assert.equal(
    (await selector.select({ utterance: '改成「带伞」', candidates, signal: new AbortController().signal })).receipt
      .accountRef,
    'platform',
  );
});
