import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJevPageSelector } from '../src/domains/concierge/action/jev/JevPageSelector.js';

const candidates = [
  { id: 'note', operation: 'fill' as const, label: '今日便签', fingerprint: 'private-dom' },
  { id: 'open', operation: 'click' as const, label: '打开清单', fingerprint: 'other-private-dom' },
];
const response = (target = 'C0', value = 'V0', model = 'jev-1.13.0') =>
  new Response(
    JSON.stringify({
      model,
      answers: {
        target: { type: 'choice', choice: target, confidence: 0.9 },
        value: { type: 'choice', choice: value, confidence: 0.9 },
      },
    }),
    { headers: { 'x-request-id': 'provider-request' } },
  );

test('real provider seam projects current candidates, selects a verbatim value and binds its receipt', async () => {
  let body: Record<string, unknown> | undefined;
  const selector = createJevPageSelector({
    apiKey: 'secret',
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(init?.redirect, 'error');
      body = JSON.parse(String(init?.body));
      return response();
    },
  });
  const result = await selector.select({
    utterance: '把今日便签填成「带伞」',
    candidates,
    signal: new AbortController().signal,
  });
  assert.deepEqual(result.choice, { kind: 'act', targetId: 'note', operation: 'fill', value: '带伞' });
  assert.equal(result.receipt.servedModel, 'jev-1.13.0');
  assert.equal(result.receipt.providerRequestId, 'provider-request');
  assert.equal(JSON.stringify(body).includes('private-dom'), false);
  assert.equal(JSON.stringify(body).includes('fingerprint'), false);
  assert.equal(JSON.stringify(body).includes('secret'), false);
  assert.equal(result.receipt.candidates.length, 2);
});

test('ASK and NONE never become executable choices', async () => {
  for (const target of ['ASK', 'NONE']) {
    const selector = createJevPageSelector({ apiKey: 'secret', fetch: async () => response(target) });
    const result = await selector.select({ utterance: '处理一下', candidates, signal: new AbortController().signal });
    assert.equal(result.choice.kind, target === 'ASK' ? 'ask' : 'none');
  }
});

test('unknown target, invented value and non-Jev or missing served model fail closed without retry', async () => {
  for (const result of [
    response('outside'),
    response('C0', 'invented'),
    response('C0', 'V0', 'gpt-6.1-sol'),
    response('C0', 'V0', ''),
  ]) {
    let calls = 0;
    const selector = createJevPageSelector({
      apiKey: 'secret',
      fetch: async () => {
        calls++;
        return result;
      },
    });
    await assert.rejects(
      selector.select({ utterance: '填入「带伞」', candidates, signal: new AbortController().signal }),
      /Jev/,
    );
    assert.equal(calls, 1);
  }
});

test('cancelled input, missing key, duplicate or oversized candidates cannot call the external provider', async () => {
  let calls = 0;
  const selector = createJevPageSelector({
    apiKey: 'secret',
    fetch: async () => {
      calls++;
      return response();
    },
  });
  await assert.rejects(selector.select({ utterance: '填入「带伞」', candidates, signal: AbortSignal.abort() }));
  await assert.rejects(
    selector.select({
      utterance: '填入「带伞」',
      candidates: [candidates[0], candidates[0]],
      signal: new AbortController().signal,
    }),
  );
  await assert.rejects(
    selector.select({
      utterance: '填入「带伞」',
      candidates: [{ ...candidates[0], label: 'x'.repeat(513) }],
      signal: new AbortController().signal,
    }),
  );
  assert.throws(() => createJevPageSelector({ apiKey: '' }));
  assert.equal(calls, 0);
});

test('HTTP failure and oversized response remain unconfirmed, with no credential in the error', async () => {
  for (const reply of [new Response('secret', { status: 401 }), new Response('x'.repeat(65_537))]) {
    const selector = createJevPageSelector({ apiKey: 'secret', fetch: async () => reply });
    await assert.rejects(
      selector.select({ utterance: '填入「带伞」', candidates, signal: new AbortController().signal }),
      (error: Error) => !error.message.includes('secret'),
    );
  }
});

test('the actually observed natural ASR supplies an unchanged literal value without injected quotes', async () => {
  let projected: { ownerRequest: string; ownerLiteralValues: string[] } | undefined;
  const selector = createJevPageSelector({
    apiKey: 'secret',
    fetch: async (_url, init) => {
      projected = JSON.parse(String(init?.body)).state;
      return response();
    },
  });
  const utterance = '把今日便签改成待伞';
  const result = await selector.select({ utterance, candidates, signal: new AbortController().signal });
  assert.equal(projected?.ownerRequest, utterance);
  assert.deepEqual(projected?.ownerLiteralValues, ['待伞']);
  assert.deepEqual(result.choice, { kind: 'act', targetId: 'note', operation: 'fill', value: '待伞' });
});

test('selected non-assignment, prefix-negation and delimited or repeated-assignment examples supply no value', async () => {
  for (const utterance of [
    '可能要带伞吧',
    '不要把今日便签改成待伞',
    '把今日便签改成待伞，然后发给别人',
    '把今日便签改成待伞，还是改成带电脑',
    '把今日便签改成',
  ]) {
    const selector = createJevPageSelector({
      apiKey: 'secret',
      fetch: async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)).state.ownerLiteralValues, []);
        return response('C0', 'ASK');
      },
    });
    const result = await selector.select({ utterance, candidates, signal: new AbortController().signal });
    assert.equal(result.choice.kind, 'ask');
  }
});
