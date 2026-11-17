import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createWatcherRequestBoundary } from '../dist/domains/concierge/watcher/watcher-request-boundary.js';
import { estimateTokens } from '../dist/utils/token-counter.js';

const prior = {
  type: 'message',
  id: 'prior-message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'prior '.repeat(2048) }],
};
const plainHistory = [
  {
    type: 'additional_tools',
    id: 'tools',
    role: 'developer',
    tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
  },
  prior,
  { type: 'function_call', id: 'f', call_id: 'f', name: 'read', arguments: '{"id":"source"}' },
  { type: 'function_call_output', call_id: 'f', output: 'bounded source' },
  { type: 'custom_tool_call', id: 'c', call_id: 'c', name: 'exec', namespace: 'functions', input: 'text("done")' },
  { type: 'custom_tool_call_output', call_id: 'c', output: 'done' },
];

// Put explicit history near the admission boundary. This chooses fixture size, not a second admission implementation.
function nearLimit(history, target = 25000) {
  const payload = (n) => ({
    input: [{ role: 'user', content: 'x '.repeat(n) }, ...history],
    tools: [],
  });
  let lo = 0;
  let hi = 30000;
  while (lo < hi) {
    const n = Math.floor((lo + hi) / 2);
    const body = payload(n);
    if (estimateTokens(JSON.stringify(body)) + 1024 + 64 * body.input.length >= target) hi = n;
    else lo = n + 1;
  }
  return payload(lo);
}

// Real HTTP boundary, local fake Responses upstream; no Codex process, Redis or paid model.
async function fixture(t, reported = true, overrides = {}) {
  const forwarded = [];
  const upstream = createServer(async (request, reply) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    forwarded.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const response = {
      output: [prior],
      ...(reported ? { usage: { input_tokens: 10, output_tokens: 2048 } } : {}),
      ...(typeof overrides === 'function' ? overrides(forwarded.length) : overrides),
    };
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.end(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const boundaries = [];
  t.after(async () => {
    for (const boundary of boundaries) await boundary.close();
  });
  async function boundary() {
    const observations = [];
    const port = await createWatcherRequestBoundary(`http://127.0.0.1:${upstream.address().port}`, {
      signal: AbortSignal.timeout(10000),
      observed(row) {
        observations.push(row);
      },
    });
    boundaries.push(port);
    return {
      port,
      observations,
      async send(body) {
        const reply = await fetch(`${port.baseUrl}/responses`, { method: 'POST', body: JSON.stringify(body) });
        const text = await reply.text();
        return { status: reply.status, text };
      },
    };
  }
  return { boundary, forwarded };
}

for (const reported of [true, false]) {
  test(`complete plaintext history has the same admission after an earlier ${reported ? 'reported' : 'unknown'} output`, async (t) => {
    const f = await fixture(t, reported);
    const fresh = await f.boundary();
    const resumed = await f.boundary();
    const body = nearLimit(plainHistory);
    assert.equal((await fresh.send(body)).status, 200);
    assert.equal(fresh.observations[0].inputUpperBound, 25000);
    assert.equal((await resumed.send({ input: 'initial request' })).status, 200);
    const result = await resumed.send(body);
    assert.equal(result.status, 200, result.text);
    assert.equal(resumed.observations[1].inputUpperBound, fresh.observations[0].inputUpperBound);
    assert.equal(resumed.observations[1].workingContextUpperBound, 29096);
    assert.equal(resumed.observations[1].maxOutputTokens, 4096);
    assert.equal(f.forwarded.length, 3, 'the complete continuation actually reaches the upstream');
    assert.deepEqual(f.forwarded[2], { ...body, max_output_tokens: 4096 });
    resumed.port.assertHealthy();
  });
}

test('opaque, reference and unknown native items retain the conservative prior-output charge', async (t) => {
  const f = await fixture(t);
  const opaqueItems = [
    { type: 'reasoning', id: 'r', encrypted_content: 'opaque-state', summary: [] },
    { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'only a summary' }] },
    { type: 'item_reference', id: 'unexpanded-state' },
    { type: 'future_native_state', payload: 'unknown' },
    { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'fixture' }] },
    { ...prior, encrypted_content: 'not-an-ordinary-message-field' },
    { type: 'compaction', encrypted_content: 'compacted-state' },
  ];
  for (const item of opaqueItems) {
    const boundary = await f.boundary();
    assert.equal((await boundary.send({ input: 'initial request' })).status, 200);
    const before = f.forwarded.length;
    const rejected = await boundary.send(nearLimit([item]));
    assert.equal(rejected.status, 400, JSON.stringify(item));
    assert.match(rejected.text, /watcher_context_budget_exceeded:27048/);
    assert.equal(f.forwarded.length, before, 'no request is sent using zero for opaque state');
    assert.throws(() => boundary.port.assertHealthy(), /watcher_context_budget_exceeded/);
  }
});

test('server-owned conversation, compaction and prompt references do not claim fully expanded plaintext', async (t) => {
  const f = await fixture(t);
  for (const state of [
    { conversation: 'server-state' },
    { context_management: [{ type: 'compaction' }] },
    { prompt: { id: 'stored-prompt' } },
  ]) {
    const boundary = await f.boundary();
    assert.equal((await boundary.send({ input: 'initial request' })).status, 200);
    const result = await boundary.send({ ...nearLimit(plainHistory), ...state });
    assert.equal(result.status, 400);
    assert.match(result.text, /watcher_context_budget_exceeded/);
  }
  assert.equal(f.forwarded.length, 3, 'only the three small initial requests reach the upstream');
});

test('opaque history with no reported usage still reserves the full previous output allowance', async (t) => {
  const f = await fixture(t, false);
  const boundary = await f.boundary();
  assert.equal((await boundary.send({ input: 'initial request' })).status, 200);
  const rejected = await boundary.send(nearLimit([{ type: 'reasoning', encrypted_content: 'unknown' }], 22000));
  assert.equal(rejected.status, 400);
  assert.match(rejected.text, /watcher_context_budget_exceeded:26096/);
  assert.equal(f.forwarded.length, 1);
});

test('plaintext above the current-input line cannot spend the 4096 output reserve or hide a response chain', async (t) => {
  const f = await fixture(t);
  for (const body of [nearLimit(plainHistory, 26000), { input: 'short', previous_response_id: 'hidden' }]) {
    const boundary = await f.boundary();
    const rejected = await boundary.send(body);
    assert.equal(rejected.status, 400);
    assert.match(rejected.text, /watcher_context_budget_exceeded|watcher_hidden_response_chain_not_budgetable/);
  }
  assert.equal(f.forwarded.length, 0);
});

function anchoredHistory() {
  const initial = { ...nearLimit([], 12000), model: 'gpt-6.1-sol' };
  const output = [
    { type: 'reasoning', id: 'r', summary: [], encrypted_content: 'opaque_token '.repeat(10000) },
    { type: 'function_call', id: 'f', call_id: 'f', name: 'read', arguments: '{}', status: 'completed' },
  ];
  const carried = output.map(({ id: _id, ...item }) => (item.type === 'reasoning' ? { ...item, content: null } : item));
  const next = {
    ...initial,
    input: [...initial.input, ...carried, { type: 'function_call_output', call_id: 'f', output: 'bounded source' }],
  };
  return { initial, output, next };
}

test('an exactly retained reasoning continuation uses the completed request usage instead of ciphertext size', async (t) => {
  const { initial, output, next } = anchoredHistory();
  const f = await fixture(t, true, { output, usage: { input_tokens: 10000, output_tokens: 2048 } });
  const boundary = await f.boundary();
  assert.equal((await boundary.send(initial)).status, 200);
  const result = await boundary.send(next);
  assert.equal(result.status, 200, result.text);
  assert.equal(boundary.observations[1].accountingBasis, 'reported_continuation');
  assert.ok(boundary.observations[1].workingContextUpperBound < 20000);
  assert.equal(boundary.observations[1].maxOutputTokens, 4096);
  assert.deepEqual(f.forwarded[1], { ...next, max_output_tokens: 4096 }, 'opaque bytes remain on the wire');
});

test('an anchor does not permit hidden, changed, unknown or over-budget context', async (t) => {
  for (const mode of [
    'tampered-ciphertext',
    'changed-prefix',
    'changed-envelope',
    'foreign-reasoning',
    'unknown-usage',
    'unknown-output',
    'anchor-over-limit',
  ]) {
    const { initial, output, next } = anchoredHistory();
    const usage =
      mode === 'unknown-usage'
        ? { output_tokens: 2048 }
        : { input_tokens: mode === 'anchor-over-limit' ? 25000 : 10000, output_tokens: 2048 };
    if (mode === 'unknown-output') output.push({ type: 'future_native_state', payload: 'unknown' });
    const f = await fixture(t, true, { output, usage });
    const boundary = await f.boundary();
    assert.equal((await boundary.send(initial)).status, 200);
    if (mode === 'tampered-ciphertext') next.input[1].encrypted_content += 'changed';
    if (mode === 'changed-prefix') next.input[0].content += 'changed';
    if (mode === 'changed-envelope') next.model = 'a-different-model';
    if (mode === 'foreign-reasoning') next.input.push({ type: 'reasoning', encrypted_content: 'foreign' });
    const denied = await boundary.send(next);
    assert.equal(denied.status, 400, `${mode}: ${denied.text}`);
    assert.match(denied.text, /watcher_context_budget_exceeded/);
    assert.equal(f.forwarded.length, 1, mode);
  }
});

test('an unknown opaque starting history cannot become a calibrated anchor merely by reporting usage', async (t) => {
  const { initial, output, next } = anchoredHistory();
  const unknown = { type: 'reasoning', encrypted_content: 'unobserved prior state', summary: [] };
  initial.input.unshift(unknown);
  next.input.unshift(unknown);
  const f = await fixture(t, true, { output, usage: { input_tokens: 10000, output_tokens: 2048 } });
  const boundary = await f.boundary();
  assert.equal((await boundary.send(initial)).status, 200);
  const result = await boundary.send(next);
  assert.equal(result.status, 400, 'a previous hidden item may not have been rendered in the reported input');
  assert.equal(f.forwarded.length, 1);
});

test('a lower subsequent usage report cannot erase earlier reasoning still carried by the exact prefix', async (t) => {
  const { initial, output, next } = anchoredHistory();
  const secondOutput = output.map((item) => ({
    ...item,
    ...(item.type === 'reasoning'
      ? { id: 'r2', encrypted_content: item.encrypted_content + 'second' }
      : { id: 'f2', call_id: 'f2' }),
  }));
  const third = {
    ...next,
    input: [
      ...next.input,
      ...secondOutput.map(({ id: _id, ...item }) => (item.type === 'reasoning' ? { ...item, content: null } : item)),
      { type: 'function_call_output', call_id: 'f2', output: 'second bounded source' },
    ],
  };
  const f = await fixture(t, true, (n) => ({
    output: n === 1 ? output : secondOutput,
    usage: { input_tokens: 10000, output_tokens: 2048 },
  }));
  const boundary = await f.boundary();
  for (const body of [initial, next, third]) {
    const result = await boundary.send(body);
    assert.equal(result.status, 200, result.text);
  }
  assert.ok(
    boundary.observations[2].inputUpperBound >= boundary.observations[1].inputUpperBound + 2048,
    'count retained generated reasoning once throughout the verified chain',
  );
});
