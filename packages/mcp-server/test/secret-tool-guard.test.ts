import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guardSecretToolCall, recordSecretExposure } from '../src/secret-tool-guard.js';
import { registerCollabToolset, registerMemoryToolset } from '../src/server-toolsets.js';
import { handleReadFileSlice } from '../src/tools/file-tools.js';

const originalFetch = globalThis.fetch;
const saved = { ...process.env };
const disposers: Array<() => Promise<void>> = [];
const credential = () => ['ghp', '_', 'F'.repeat(36)].join('');

async function clientFor(family: 'collab' | 'memory') {
  const server = new McpServer({ name: 'secret-guard-test', version: '1' });
  if (family === 'collab') registerCollabToolset(server, {});
  else registerMemoryToolset(server, {});
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'consumer-test', version: '1' });
  await Promise.all([server.connect(left), client.connect(right)]);
  disposers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  globalThis.fetch = originalFetch;
  process.env = { ...saved };
  mock.restoreAll();
});

describe('registered MCP transport secret protection', () => {
  it('does not notify about unavailable inspection as if a configured credential was exposed', async () => {
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:59999';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-secret-test';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'callback-test';
    const requests: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(String(init?.body));
      return new Response('{"messageId":"inspection-notice"}', { status: 200 });
    }) as typeof fetch;
    await recordSecretExposure({ state: 'exposed_or_suspected', rules: ['uninspectable-result'] });
    assert.equal(requests.length, 0);
  });

  it('reads credential aliases within the authorised workspace and collection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secret-file-resolution-'));
    const data = join(root, 'data');
    process.env.ALLOWED_WORKSPACE_DIRS = root;
    process.env.CAT_CAFE_DATA_DIR = data;
    await mkdir(join(data, 'library'), { recursive: true });
    await writeFile(join(data, 'library', 'collections.json'), JSON.stringify([{ id: 'world:fixture', root }]));
    const credential = join(root, '.env.local');
    await writeFile(credential, 'opaque fixture credential');
    await symlink(credential, join(root, 'notes.txt'));
    await writeFile(join(root, 'public.txt'), 'ordinary source');
    try {
      for (const path of ['notes.txt', 'cat-cafe://collection/world%3Afixture/notes.txt']) {
        const result = await guardSecretToolCall('cat_cafe_read_file_slice', { path, startLine: 1 }, () =>
          handleReadFileSlice({ path, startLine: 1 }),
        );
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /opaque fixture credential/);
      }
      for (const path of ['public.txt', 'cat-cafe://collection/world%3Afixture/public.txt']) {
        const result = await guardSecretToolCall('cat_cafe_read_file_slice', { path, startLine: 1 }, () =>
          handleReadFileSlice({ path, startLine: 1 }),
        );
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /ordinary source/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes a local memory read query even when its text resembles a credential', async () => {
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:59999';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-secret-test';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'callback-test';
    const calls = mock.fn(async () => new Response('{"results":[]}', { status: 200 }));
    globalThis.fetch = calls as typeof fetch;
    const client = await clientFor('memory');
    const result = await client.callTool({ name: 'cat_cafe_search_evidence', arguments: { query: credential() } });
    assert.equal(result.isError, undefined);
    assert.equal(calls.mock.callCount(), 1);
  });

  it('returns redacted history and posts a credential-free notice to the same authenticated invocation', async () => {
    process.env.GH_TOKEN = credential();
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:59999';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-secret-test';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'callback-test';
    const requests: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        body: String(init?.body ?? ''),
        headers: init?.headers as Record<string, string>,
      });
      const data = String(url).includes('post-message')
        ? { status: 'ok', messageId: 'notice-1' }
        : { message: { content: credential() } };
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = await clientFor('collab');
    const result = await client.callTool({
      name: 'cat_cafe_get_message',
      arguments: { messageId: 'fixture-message', mode: 'full' },
    });
    assert.ok(!JSON.stringify(result).includes(credential()));
    const notices = requests.filter((request) => request.url.includes('post-message'));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].headers['x-invocation-id'], 'inv-secret-test');
    assert.equal(notices[0].headers['x-callback-token'], 'callback-test');
    assert.ok(!notices[0].body.includes(credential()));
    assert.ok(notices[0].body.includes('当前已配置的凭据值'));
    assert.ok(!notices[0].body.includes('请轮转相关凭据'));
  });
});
