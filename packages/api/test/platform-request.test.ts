import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import { executePlatformRequest } from '../src/domains/services/openai-platform/request.js';

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'platform-request-'));
  previousRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  mkdirSync(join(root, '.cat-cafe'));
  mkdirSync(join(root, 'inputs'));
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({
      '11': { authType: 'api_key', clientId: 'openai', baseUrl: 'api.openai.com', models: ['gpt-6'] },
    }),
  );
  writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify({ '11': { apiKey: 'FAKE_PLATFORM_KEY' } }));
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});
const options = (fetch: typeof globalThis.fetch) => ({
  projectRoot: root,
  fileRoot: join(root, 'inputs'),
  outputDir: join(root, 'outputs'),
  auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }),
  fetch,
});
const input = (request: Record<string, unknown>) => ({ accountRef: '11', request });

test('full JSON parameters and caller model reach the official API, independently of account models', async () => {
  const body = {
    model: 'a-new-model',
    input: [{ role: 'user', content: 'fixture' }],
    temperature: 0,
    response_format: { type: 'json_object' },
    future_parameter: { array: [1, null, false] },
  };
  const raw = '{"output_text":"fixture","future_response":{"a":1},"usage":{"input_tokens":3,"output_tokens":4}}\n';
  let calls = 0;
  const result = await executePlatformRequest(
    options(async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer FAKE_PLATFORM_KEY');
      assert.equal(new Headers(init?.headers).get('openai-project'), 'fixture-project');
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      assert.ok(init?.signal);
      return new Response(raw, {
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'fixture-req',
          'set-cookie': '__cf_bm=fixture-cookie',
        },
      });
    }),
    input({
      method: 'POST',
      path: '/v1/responses',
      headers: { 'OpenAI-Project': 'fixture-project' },
      contentType: 'application/json',
      body,
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.requestId, 'fixture-req');
  assert.equal(result.responseHeaders?.['set-cookie'], undefined);
  assert.equal(result.model, 'a-new-model');
  assert.equal(readFileSync(result.responseFile, 'utf8'), raw);
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4 });
  assert.equal(result.cost, null);
  assert.ok(result.timeoutMs >= 300_000);
  assert.equal(JSON.stringify(result).includes('FAKE_PLATFORM_KEY'), false);
  assert.equal(readFileSync(result.receiptFile, 'utf8').includes('FAKE_PLATFORM_KEY'), false);
});
test('the actual GIF multipart shape preserves arbitrary parameters, file bytes and repeated fields', async () => {
  const image = Buffer.alloc(1_450_000, 0x81);
  writeFileSync(join(root, 'inputs/ref.png'), image);
  writeFileSync(join(root, 'inputs/prompt.txt'), '印印盖章 fixture');
  const response = JSON.stringify({
    data: [{ b64_json: 'R'.repeat(3_000_000) }],
    usage: { input_tokens: 1455, output_tokens: 3568 },
  });
  const result = await executePlatformRequest(
    options(async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/images/edits');
      assert.equal(new Headers(init?.headers).has('content-type'), false, 'fetch must generate the multipart boundary');
      assert.ok(init?.body instanceof FormData);
      const form = init.body;
      assert.equal(form.get('model'), 'gpt-image-2.6-sunburst');
      assert.equal(form.get('frame_count'), '16');
      assert.equal(form.get('complexity'), 'high');
      assert.equal(form.get('prompt'), '印印盖章 fixture');
      assert.deepEqual(form.getAll('tag'), ['first', 'second']);
      const uploaded = form.get('image');
      assert.ok(uploaded instanceof Blob);
      assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), image);
      return new Response(response, { headers: { 'content-type': 'application/json' } });
    }),
    input({
      method: 'POST',
      path: '/v1/images/edits',
      contentType: 'multipart/form-data',
      fields: {
        model: 'gpt-image-2.6-sunburst',
        output_format: 'gif',
        frame_count: '16',
        frame_duration_ms: '160',
        quality: 'high',
        complexity: 'high',
        prompt: { fromFile: 'prompt.txt' },
        tag: ['first', 'second'],
      },
      files: { image: { path: 'ref.png', contentType: 'image/png' } },
    }),
  );
  assert.equal(readFileSync(result.responseFile, 'utf8'), response);
  assert.deepEqual(result.usage, { input_tokens: 1455, output_tokens: 3568 });
});
test('binary and SSE results remain original bytes; usage is recorded without replacing the response', async () => {
  const wav = Buffer.from([82, 73, 70, 70, 0, 255, 42, 0, 1]);
  for (const [contentType, bytes] of [
    ['audio/wav', wav],
    [
      'text/event-stream',
      Buffer.from('data: {"response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\ndata: [DONE]\n\n'),
    ],
  ] as const) {
    const result = await executePlatformRequest(
      options(async () => new Response(bytes, { headers: { 'content-type': contentType } })),
      input({
        method: 'POST',
        path: '/v1/audio/speech',
        contentType: 'application/json',
        body: { model: 'caller-model', input: 'fixture' },
      }),
    );
    assert.deepEqual(readFileSync(result.responseFile), bytes);
    assert.equal(result.contentType, contentType);
    assert.deepEqual(result.usage, contentType === 'audio/wav' ? null : { input_tokens: 2, output_tokens: 1 });
  }
});
test('non-2xx provider responses are preserved; no paid retry or error-body substitution occurs', async () => {
  let calls = 0;
  const raw = '{"error":{"type":"invalid_parameter","message":"caller chooses parameters"}}';
  const result = await executePlatformRequest(
    options(async () => {
      calls++;
      return new Response(raw, { status: 400, headers: { 'content-type': 'application/json' } });
    }),
    input({
      method: 'POST',
      path: '/v1/decisions',
      contentType: 'application/json',
      body: { model: 'caller-model', unknown: true },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.status, 'http_error');
  assert.equal(result.httpStatus, 400);
  assert.equal(readFileSync(result.responseFile, 'utf8'), raw);
});
test('foreign destinations, administrative APIs, auth overrides and credential/file escapes never send', async () => {
  let calls = 0;
  const opts = options(async () => {
    calls++;
    return Response.json({});
  });
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'private fixture');
  symlinkSync(outside, join(root, 'inputs/escaped.txt'));
  symlinkSync(join(root, '.cat-cafe/credentials.json'), join(root, 'inputs/credentials.txt'));
  for (const request of [
    { method: 'POST', path: 'https://other.invalid/v1/responses' },
    { method: 'POST', path: '/v1/../organization/api_keys' },
    { method: 'POST', path: '/v1/fine_tuning/jobs' },
    { method: 'POST', path: '/v1/responses', headers: { Authorization: 'caller-key' } },
    { method: 'POST', path: '/v1/responses', contentType: 'application/json', body: { input: 'FAKE_PLATFORM_KEY' } },
    ...['escaped.txt', 'credentials.txt'].map((path) => ({
      method: 'POST',
      path: '/v1/audio/transcriptions',
      contentType: 'multipart/form-data',
      files: { file: { path } },
    })),
  ])
    await assert.rejects(executePlatformRequest(opts, input(request)));
  await assert.rejects(
    executePlatformRequest(
      { ...opts, outputDir: join(root, 'FAKE_PLATFORM_KEY') },
      input({ method: 'GET', path: '/v1/models' }),
    ),
  );
  assert.equal(calls, 0);
});
test('an interrupted response is unconfirmed, cleans partial files, and never retries a sent call', async () => {
  const controller = new AbortController();
  let calls = 0;
  const opts = {
    ...options(async () => {
      calls++;
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"partial":'));
            setTimeout(() => controller.abort(), 15);
          },
        }),
      );
    }),
    signal: controller.signal,
  };
  const result = await executePlatformRequest(
    opts,
    input({ method: 'POST', path: '/v1/responses', contentType: 'application/json', body: { model: 'fixture' } }),
  );
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.responseFile, null);
  assert.equal(calls, 1);
  const folder = join(root, 'outputs', result.callId);
  assert.deepEqual(readdirSync(folder), ['receipt.json']);
});
test('oversized or credential-echoing streams never publish a partial response or repeat the call', async () => {
  for (const echo of [false, true]) {
    let calls = 0;
    const bytes = echo ? ['safe prefix FAKE_PLAT', 'FORM_KEY suffix'] : ['too', 'large'];
    const result = await executePlatformRequest(
      options(async () => {
        calls++;
        return new Response(
          new ReadableStream({
            start(stream) {
              for (const chunk of bytes) stream.enqueue(new TextEncoder().encode(chunk));
              stream.close();
            },
          }),
        );
      }),
      {
        ...input({
          method: 'POST',
          path: '/v1/responses',
          contentType: 'application/json',
          body: { model: 'fixture' },
        }),
        maxResponseBytes: echo ? 4096 : 4,
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.responseFile, null);
    assert.deepEqual(readdirSync(join(root, 'outputs', result.callId)), ['receipt.json']);
    assert.equal(readFileSync(result.receiptFile, 'utf8').includes('FAKE_PLATFORM_KEY'), false);
  }
});
