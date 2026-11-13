import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { resolveForClient } from '../src/config/account-resolver.js';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import { executePlatformRequest } from '../src/domains/services/openai-platform/request.js';
import { accountsRoutes } from '../src/routes/accounts.js';

const PROJECT = 'household-proj-1';
const SECRETS = ['FIXTURE_CLIENT_SECRET', 'FIXTURE_REFRESH_TOKEN', 'FIXTURE_ACCESS_TOKEN'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPED = `/v1/projects/${PROJECT}/locations/global`;
let root: string;
const saved: Record<string, string | undefined> = {};
function adc(value: Record<string, unknown>) {
  writeFileSync(join(root, 'adc.json'), JSON.stringify(value));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'google-cloud-platform-'));
  for (const name of ['CAT_CAFE_GLOBAL_CONFIG_ROOT', 'GOOGLE_APPLICATION_CREDENTIALS']) saved[name] = process.env[name];
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = join(root, 'adc.json');
  mkdirSync(join(root, '.cat-cafe'));
  mkdirSync(join(root, 'inputs'));
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({
      gemini: { authType: 'oauth', clientId: 'google' },
      cloud: { authType: 'oauth', clientId: 'google', googleCloud: { credential: 'local_adc', projectId: PROJECT } },
    }),
  );
  writeFileSync(join(root, '.cat-cafe/credentials.json'), '{}');
  adc({
    type: 'authorized_user',
    client_id: 'fixture-client.apps.googleusercontent.com',
    client_secret: 'FIXTURE_CLIENT_SECRET',
    refresh_token: 'FIXTURE_REFRESH_TOKEN',
  });
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Google's token endpoint and Vertex, recorded separately. */
function google(
  vertex: (url: string, init?: RequestInit) => Response,
  token = () => Response.json({ access_token: 'FIXTURE_ACCESS_TOKEN', expires_in: 3599 }),
) {
  const calls = { token: [] as string[], vertex: [] as string[] };
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === TOKEN_URL) {
      assert.equal(init?.redirect, 'error');
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'FIXTURE_REFRESH_TOKEN');
      calls.token.push(String(url));
      return token();
    }
    calls.vertex.push(String(url));
    return vertex(String(url), init);
  }) as typeof globalThis.fetch;
  return {
    calls,
    options: {
      projectRoot: root,
      fileRoot: join(root, 'inputs'),
      outputDir: join(root, 'outputs'),
      auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }),
      fetch,
    },
  };
}

test('a Google Cloud account refreshes the local login and calls Vertex on its own project', async () => {
  const raw = '{"candidates":[],"usageMetadata":{"totalTokenCount":5}}\n';
  const { calls, options } = google((url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(
      url,
      `https://aiplatform.googleapis.com${SCOPED}/publishers/google/models/gemini-fixture:generateContent`,
    );
    assert.equal(init?.redirect, 'error');
    assert.equal(headers.get('authorization'), 'Bearer FIXTURE_ACCESS_TOKEN');
    assert.equal(headers.get('x-goog-user-project'), PROJECT);
    assert.equal(headers.get('x-goog-api-key'), null);
    return new Response(raw, { headers: { 'content-type': 'application/json' } });
  });
  const result = await executePlatformRequest(options, {
    accountRef: 'cloud',
    request: {
      method: 'POST',
      path: `${SCOPED}/publishers/google/models/gemini-fixture:generateContent`,
      contentType: 'application/json',
      body: { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }] },
    },
  });
  assert.deepEqual(calls, { token: [TOKEN_URL], vertex: [calls.vertex[0]] });
  assert.equal(result.provider, 'google');
  assert.equal(result.status, 'completed');
  assert.equal(result.model, 'gemini-fixture');
  assert.deepEqual(result.usage, { totalTokenCount: 5 });
  assert.equal(readFileSync(result.responseFile as string, 'utf8'), raw);
  const persisted = JSON.stringify(result) + readFileSync(result.receiptFile, 'utf8');
  for (const secret of SECRETS) assert.equal(persisted.includes(secret), false, secret);
});

test('a regional location picks its Vertex host; Lyria interactions carry the model in the body', async () => {
  const urls: string[] = [];
  const { options } = google((url) => {
    urls.push(url);
    return Response.json({});
  });
  const veo = `/v1/projects/${PROJECT}/locations/us-central1/publishers/google/models/veo-fixture:predictLongRunning`;
  const regional = await executePlatformRequest(options, {
    accountRef: 'cloud',
    request: { method: 'POST', path: veo, contentType: 'application/json', body: { instances: [{ prompt: 'x' }] } },
  });
  const lyria = await executePlatformRequest(options, {
    accountRef: 'cloud',
    request: {
      method: 'POST',
      path: `/v1beta1/projects/${PROJECT}/locations/global/interactions`,
      contentType: 'application/json',
      body: { model: 'lyria-3-clip-preview', input: [{ type: 'text', text: 'fixture' }], store: false },
    },
  });
  assert.deepEqual(urls, [
    `https://us-central1-aiplatform.googleapis.com${veo}`,
    `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/global/interactions`,
  ]);
  const catalog = await executePlatformRequest(options, {
    accountRef: 'cloud',
    request: { method: 'GET', path: '/v1beta1/publishers/google/models?pageSize=50' },
  });
  assert.equal(catalog.status, 'completed');
  assert.equal(urls.at(-1), 'https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=50');
  assert.equal(regional.model, 'veo-fixture');
  assert.equal(lyria.model, 'lyria-3-clip-preview');
});

test('Google Cloud requests off the account project, with caller authentication or a bad login never reach Vertex', async () => {
  const generate = `${SCOPED}/publishers/google/models/gemini-fixture:generateContent`;
  const json = { contentType: 'application/json', body: {} };
  const refused = [
    { method: 'POST', path: '/v1/publishers/google/models/gemini-fixture:generateContent', ...json },
    // Only the catalog itself skips the project; a single model's detail still names the account project.
    { method: 'GET', path: '/v1/publishers/google/models/gemini-fixture' },
    { method: 'POST', path: generate.replace(PROJECT, 'another-project-9'), ...json },
    { method: 'POST', path: generate.replace('/global/', '/evil.example/'), ...json },
    { method: 'POST', path: generate, headers: { 'X-Goog-User-Project': 'another-project-9' }, ...json },
    { method: 'POST', path: generate, headers: { Authorization: 'Bearer caller' }, ...json },
    { method: 'POST', path: generate, contentType: 'application/json', body: { text: 'FIXTURE_REFRESH_TOKEN' } },
    { method: 'POST', path: generate, contentType: 'multipart/form-data', fields: { a: 'b' } },
  ];
  const { calls, options } = google(() => Response.json({}));
  for (const request of refused)
    await assert.rejects(executePlatformRequest(options, { accountRef: 'cloud', request }), JSON.stringify(request));
  assert.equal(calls.vertex.length, 0);
  const detail = google(() => Response.json({}));
  const detailRequest = { method: 'GET', path: '/v1/publishers/google/models/gemini-fixture' };
  await assert.rejects(executePlatformRequest(detail.options, { accountRef: 'cloud', request: detailRequest }));
  assert.deepEqual(detail.calls, { token: [], vertex: [] });

  const sendable = { accountRef: 'cloud', request: { method: 'POST', path: generate, ...json } };
  const denied = google(
    () => Response.json({}),
    () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
  );
  await assert.rejects(executePlatformRequest(denied.options, sendable), { code: 'platform_account_unavailable' });
  assert.equal(denied.calls.vertex.length, 0);
  for (const login of [{ type: 'service_account', private_key: 'x' }, { type: 'authorized_user' }]) {
    adc(login);
    const unused = google(() => Response.json({}));
    await assert.rejects(executePlatformRequest(unused.options, sendable), { code: 'platform_account_unavailable' });
    assert.deepEqual(unused.calls, { token: [], vertex: [] });
  }
});

test('creating a Google Cloud account stores only the project, keeps it on edit and leaves Gemini login alone', async () => {
  const app = Fastify();
  await app.register(accountsRoutes);
  const send = (method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) =>
    app.inject({ method, url, headers: { 'x-cat-cafe-user': 'fixture' }, payload: { projectPath: root, ...payload } });
  try {
    const owned = { displayName: 'Google Cloud', authType: 'oauth', clientId: 'google' };
    for (const payload of [
      { ...owned, googleCloudProjectId: 'Bad_Project' },
      { ...owned, googleCloudProjectId: PROJECT, apiKey: 'FAKE' },
      { ...owned, clientId: 'openai', googleCloudProjectId: PROJECT },
    ])
      assert.equal((await send('POST', '/api/accounts', payload)).statusCode, 400, JSON.stringify(payload));
    const created = await send('POST', '/api/accounts', { ...owned, googleCloudProjectId: PROJECT });
    assert.equal(created.statusCode, 200, created.body);
    const { id, googleCloud } = created.json().profile;
    assert.match(id, /^google-cloud-/u);
    assert.deepEqual(googleCloud, { credential: 'local_adc', projectId: PROJECT });
    const renamed = await send('PATCH', `/api/accounts/${id}`, { displayName: 'Vertex' });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal((await send('PATCH', `/api/accounts/${id}`, { apiKey: 'FAKE' })).statusCode, 400);
    const stored = JSON.parse(readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8'))[id];
    assert.deepEqual(stored.googleCloud, { credential: 'local_adc', projectId: PROJECT });
    assert.equal(stored.displayName, 'Vertex');
    assert.equal(readFileSync(join(root, '.cat-cafe/credentials.json'), 'utf8').includes(id), false);
    assert.equal(resolveForClient(root, 'google')?.id, 'gemini');
  } finally {
    await app.close();
  }
});
