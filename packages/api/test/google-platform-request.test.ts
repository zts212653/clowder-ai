import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import { executePlatformRequest } from '../src/domains/services/openai-platform/request.js';

const KEY = 'FAKE_GOOGLE_PLATFORM_KEY';
// A household Google platform account means Vertex AI on Google Cloud billing, not AI Studio.
const VERTEX = 'https://aiplatform.googleapis.com';
const MODELS = '/v1/publishers/google/models';
const SCOPED = '/v1/projects/p1/locations/global';
let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'google-platform-request-'));
  previousRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  mkdirSync(join(root, '.cat-cafe'));
  mkdirSync(join(root, 'inputs'));
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({
      vertex: { authType: 'api_key', clientId: 'google' },
      regional: {
        authType: 'api_key',
        clientId: 'google',
        baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1',
      },
      '11': { authType: 'api_key', clientId: 'openai' },
    }),
  );
  writeFileSync(
    join(root, '.cat-cafe/credentials.json'),
    JSON.stringify({ vertex: { apiKey: KEY }, regional: { apiKey: KEY }, '11': { apiKey: 'FAKE_OPENAI_KEY' } }),
  );
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

test('a Google account sends the caller body to Vertex AI by default, with header authentication only', async () => {
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'fixture' }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    future_parameter: { array: [1, null, false] },
  };
  const raw = '{"candidates":[],"usageMetadata":{"promptTokenCount":3,"totalTokenCount":7}}\n';
  let calls = 0;
  const result = await executePlatformRequest(
    options(async (url, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      assert.equal(url, `${VERTEX}${MODELS}/gemini-fixture-image:generateContent`);
      assert.equal(init?.redirect, 'error');
      assert.equal(headers.get('x-goog-api-key'), KEY);
      assert.equal(headers.get('authorization'), null);
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      return new Response(raw, { headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }),
    {
      accountRef: 'vertex',
      request: {
        method: 'POST',
        path: `${MODELS}/gemini-fixture-image:generateContent`,
        contentType: 'application/json',
        body,
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.provider, 'google');
  assert.equal(result.status, 'completed');
  assert.equal(result.model, 'gemini-fixture-image');
  assert.equal(readFileSync(result.responseFile as string, 'utf8'), raw);
  assert.deepEqual(result.usage, { promptTokenCount: 3, totalTokenCount: 7 });
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(readFileSync(result.receiptFile, 'utf8').includes(KEY), false);
});

test('Vertex model listing, scoped long-running, streaming and Lyria interaction paths reach one URL each', async () => {
  const regional = 'https://us-central1-aiplatform.googleapis.com';
  const veo = '/v1/projects/p1/locations/us-central1/publishers/google/models/veo-fixture';
  const cases = [
    [
      'vertex',
      'GET',
      '/v1beta1/publishers/google/models?pageSize=5',
      `${VERTEX}/v1beta1/publishers/google/models?pageSize=5`,
      null,
    ],
    ['regional', 'POST', `${veo}:predictLongRunning`, `${regional}${veo}:predictLongRunning`, 'veo-fixture'],
    ['regional', 'POST', `${veo}:fetchPredictOperation`, `${regional}${veo}:fetchPredictOperation`, 'veo-fixture'],
    ['regional', 'GET', `${veo}/operations/op-1`, `${regional}${veo}/operations/op-1`, 'veo-fixture'],
    ['vertex', 'POST', `${MODELS}/gemini-fixture:streamGenerateContent?alt=sse`, null, 'gemini-fixture'],
    // Lyria interactions name the model in the body, as the official request shape does.
    ['vertex', 'POST', '/v1beta1/projects/p1/locations/global/interactions', null, 'lyria-3-clip-preview'],
    ['vertex', 'GET', '/v1beta1/projects/p1/locations/global/interactions/i-1', null, null],
  ] as const;
  for (const [accountRef, method, path, expected, model] of cases) {
    const sse = path.includes('alt=sse');
    const urls: string[] = [];
    const result = await executePlatformRequest(
      options(async (url, init) => {
        urls.push(String(url));
        assert.equal(new Headers(init?.headers).get('x-goog-api-key'), KEY);
        return sse
          ? new Response(
              'data: {"usageMetadata":{"totalTokenCount":1}}\n\ndata: {"usageMetadata":{"totalTokenCount":9}}\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            )
          : Response.json({});
      }),
      {
        accountRef,
        request:
          method === 'POST'
            ? {
                method,
                path,
                contentType: 'application/json',
                body: path.endsWith('/interactions')
                  ? { model: 'lyria-3-clip-preview', input: [{ type: 'text', text: 'fixture' }], store: false }
                  : { instances: [{ prompt: 'fixture' }] },
              }
            : { method, path },
      },
    );
    assert.deepEqual(urls, [expected ?? `${VERTEX}${path}`], path);
    assert.equal(result.model, model, path);
    if (sse) assert.deepEqual(result.usage, { totalTokenCount: 9 });
  }
});

test('Google requests outside Vertex model inference, or carrying caller credentials, never send', async () => {
  let calls = 0;
  const opts = options(async () => {
    calls++;
    return Response.json({});
  });
  const generate = `${MODELS}/gemini-fixture:generateContent`;
  for (const [accountRef, request] of [
    ['vertex', { method: 'POST', path: '/v1/responses', contentType: 'application/json', body: {} }],
    ['vertex', { method: 'POST', path: '/v1beta/models/gemini-fixture:generateContent', body: {} }],
    ['11', { method: 'POST', path: generate, contentType: 'application/json', body: {} }],
    ['vertex', { method: 'GET', path: '/v1/publishers/google/models?key=caller-key' }],
    ['vertex', { method: 'GET', path: 'https://other.invalid/v1/publishers/google/models' }],
    ['vertex', { method: 'GET', path: '/v1/publishers/google/models/../../../projects' }],
    ['vertex', { method: 'POST', path: `${SCOPED}/endpoints/e1:predict`, contentType: 'application/json', body: {} }],
    ['vertex', { method: 'POST', path: `${SCOPED}/tuningJobs`, contentType: 'application/json', body: {} }],
    ['vertex', { method: 'DELETE', path: `${SCOPED}/operations/op-1` }],
    ['vertex', { method: 'POST', path: generate, headers: { 'X-Goog-Api-Key': 'caller-key' }, body: {} }],
    ['vertex', { method: 'POST', path: generate, contentType: 'application/json', body: { text: KEY } }],
    ['vertex', { method: 'POST', path: generate, contentType: 'multipart/form-data', fields: { a: 'b' } }],
  ] as const)
    await assert.rejects(executePlatformRequest(opts, { accountRef, request }), JSON.stringify(request));
  assert.equal(calls, 0);
});
