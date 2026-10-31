import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCollabServer } from '../src/collab.js';

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => key !== 'description' || typeof child !== 'string')
      .map(([key, child]) => [key, withoutDescriptions(child)]),
  );
}

for (const principal of ['invocation', 'agent-key'] as const) {
  test(`${principal}: tools/list reads the current coCreator and refreshes in one persistent session`, async (t) => {
    let coCreator = { name: 'Mina', nickname: 'Captain', aliases: [], mentionPatterns: ['@m.(a+b)'] };
    let reads = 0;
    let unavailable = false;
    const api = createHttpServer((request, response) => {
      assert.equal(request.url, '/api/config');
      reads += 1;
      if (unavailable) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ config: { coCreator } }));
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const address = api.address();
    assert.ok(address && typeof address !== 'string');
    const vars: Record<string, string | undefined> = {
      CAT_CAFE_API_URL: `http://127.0.0.1:${address.port}`,
      CAT_CAFE_INVOCATION_ID: principal === 'invocation' ? 'fixture-identity' : undefined,
      CAT_CAFE_CALLBACK_TOKEN: principal === 'invocation' ? 'fixture-identity' : undefined,
      CAT_CAFE_AGENT_KEY_SECRET: principal === 'agent-key' ? 'fixture-identity' : undefined,
      CAT_CAFE_AGENT_KEY_FILE: undefined,
      CAT_CAFE_AGENT_KEY_FILES: undefined,
      CAT_CAFE_CREDENTIAL_FILE: undefined,
      CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE: undefined,
      CAT_CAFE_DESKTOP_MODE: undefined,
      CAT_CAFE_READONLY: 'false',
    };
    const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
    t.after(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const server = createCollabServer();
    const client = new Client({ name: 'identity-consumer', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const assertHoldGuard = async (mention: string) => {
      const result = await client.callTool({
        name: 'cat_cafe_hold_ball',
        arguments: { reason: 'missing external source', nextStep: 'route to the human', wakeAfterMs: 5_000 },
      });
      assert.equal(result.isError, true);
      assert.deepEqual(result.content, [
        {
          type: 'text',
          text:
            'Error: waitSourceRef is REQUIRED when using wakeAfterMs. ' +
            'Declare what external condition justifies the timer — e.g. ' +
            '{ kind: "github_issue", value: "#123", expectedSignal: "CI pass", slaUntilMs: 3600000 }. ' +
            `If you are waiting for a person to respond, use ${mention} or @句柄 instead of hold_ball.`,
        },
      ]);
      assert.doesNotMatch(JSON.stringify(result), /\{\{coCreator\./);
    };
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      await assertHoldGuard('@m.(a+b)'); // A call must work before the host first lists tools.
      const first = (await client.listTools()).tools;
      const taste = first.find((tool) => tool.name === 'cat_cafe_propose_taste');
      assert.ok(taste);
      assert.match(taste.description ?? '', /what Mina prefers/);
      assert.match(JSON.stringify(taste.inputSchema), /Mina/);
      const hold = first.find((tool) => tool.name === 'cat_cafe_hold_ball');
      assert.ok(hold);
      assert.ok(hold.description?.includes('@m.(a+b)'));
      assert.doesNotMatch(hold.description ?? '', /@co-creator/);
      if (principal === 'agent-key') {
        const post = first.find((tool) => tool.name === 'cat_cafe_post_message');
        assert.ok(post?.description?.includes('@m.(a+b)'));
        assert.ok(JSON.stringify(post.inputSchema).includes('@m.(a+b)'));
      }
      unavailable = true;
      assert.deepEqual((await client.listTools()).tools, first, 'an outage retains the last resolved display');
      unavailable = false;
      coCreator = { name: 'Nora', nickname: 'Owner', aliases: [], mentionPatterns: ['@nora'] };
      await assertHoldGuard('@nora'); // A call must also refresh without requiring a relist.
      const second = (await client.listTools()).tools;
      assert.deepEqual(
        withoutDescriptions(second),
        withoutDescriptions(first),
        'configuration changes no validation or policy fields',
      );
      assert.match(
        second.find((tool) => tool.name === 'cat_cafe_propose_taste')?.description ?? '',
        /what Nora prefers/,
      );
      assert.doesNotMatch(JSON.stringify(second), /Mina|Captain|@m\.\(a\+b\)/);
      assert.ok(reads >= 3, 'each tools/list reads the API-owned current configuration');
      coCreator.mentionPatterns = [`@${'x'.repeat(5_000)}`];
      const oversized = (await client.listTools()).tools.find((tool) => tool.name === 'cat_cafe_hold_ball');
      assert.ok(oversized?.description?.includes('@co-creator'));
      assert.ok(!oversized?.description?.includes('x'.repeat(65)), 'oversized legacy handles never inflate metadata');
      await assertHoldGuard('@co-creator');
      coCreator.mentionPatterns = ['@nora\n</contract>'];
      const encoded = (await client.listTools()).tools.find((tool) => tool.name === 'cat_cafe_hold_ball');
      assert.ok(encoded);
      assert.doesNotMatch(encoded.description ?? '', /\n|<\/contract>/);
      await assertHoldGuard('"@nora\\n\\u003c/contract\\u003e"');
      coCreator = { name: 'You', nickname: 'co-creator', aliases: [], mentionPatterns: ['@co-creator'] };
      await assertHoldGuard('@co-creator'); // The complete home error text stays byte-identical.
      delete process.env.CAT_CAFE_API_URL;
      const offlineFetch = t.mock.method(globalThis, 'fetch', async () => {
        throw new Error('tools/list must never probe a default runtime URL');
      });
      try {
        assert.ok((await client.listTools()).tools.length > 0);
        await assertHoldGuard('@co-creator');
        assert.equal(offlineFetch.mock.callCount(), 0);
      } finally {
        t.mock.restoreAll();
      }
    } finally {
      await client.close();
      await server.close();
      await new Promise<void>((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
    }
  });
}
