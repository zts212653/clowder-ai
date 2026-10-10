import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.ts';
import { createCanonicalLiveSourceFixture as fixture } from './helpers/1398-live-source-fixture.mjs';

// No separate completeAdopted/receipt protocol: the exact admitted native
// child accepts the body through the same HTTP/MCP full-context entry point.
for (const transport of ['http', 'mcp']) {
  test(
    'production Host ' + transport + ' binds body delivery to one native child and rejects reuse after close',
    async () => {
      const sessions = new LiveCompanionSessions();
      const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' }, 'agent', {
        targetCats: ['codex-astra'],
        withLiveCarrierOperation: sessions.withCarrierOperation.bind(sessions),
      });
      let mcp, call;
      try {
        const apiUrl = await f.app.listen({ port: 0, host: '127.0.0.1' });
        call = await sessions.prepare({
          binding: { userId: 'owner', threadId: 'home', catId: 'codex-astra', callId: 'call' },
          messageStore: f.store,
          mcpDistDir: resolve('../mcp-server/dist'),
          allowedDirectories: [resolve('../../docs')],
          verifyNativeBinding: async () => true,
          publish() {},
        });
        await sessions.claim(call.id, 'owner', 'home', ['codex-astra']);
        const config = await call.configure({
          CAT_CAFE_API_URL: apiUrl,
          CAT_CAFE_USER_ID: 'owner',
          CAT_CAFE_THREAD_ID: 'home',
          CAT_CAFE_CAT_ID: 'codex-astra',
          CAT_CAFE_INVOCATION_ID: f.auth.invocationId,
          CAT_CAFE_CALLBACK_TOKEN: f.auth.callbackToken,
        });
        await call.ready('native', { request: async () => ({}), submitText: async () => 'unused' });
        const meta = { threadId: 'native', 'x-codex-turn-metadata': { thread_id: 'native', turn_id: 'native-turn' } };
        await call.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'native-turn' } } });
        if (transport === 'mcp') {
          const server = config.mcp_servers['cat-cafe-collab'];
          mcp = new Client({ name: 'canonical-live-delivery', version: '1' });
          await mcp.connect(
            new StdioClientTransport({ command: server.command, args: server.args, env: server.env, stderr: 'pipe' }),
          );
          const tools = new Set((await mcp.listTools()).tools.map((tool) => tool.name));
          assert.equal(tools.has('cat_cafe_complete_a2a_dispatch'), false);
          const anchor = await mcp.callTool({ name: 'cat_cafe_get_thread_context', arguments: {}, _meta: meta });
          assert.notEqual(anchor.isError, true, JSON.stringify(anchor));
          await pendingSingle(f);
          const body = await mcp.callTool({
            name: 'cat_cafe_get_thread_context',
            arguments: { responseMode: 'full' },
            _meta: meta,
          });
          assert.notEqual(body.isError, true, JSON.stringify(body));
          assert.match(JSON.stringify(body), new RegExp(f.message.id));
        } else {
          const anchor = await f.app.inject({
            method: 'GET',
            url: '/api/callbacks/thread-context',
            headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
          });
          assert.equal(anchor.statusCode, 200);
          await pendingSingle(f);
          assert.equal((await f.read()).statusCode, 200);
        }
        const source = f.store.getById(f.message.id);
        assert.deepEqual(f.queue.list('home', 'owner'), []);
        assert.equal(source.lifecycle.dispatchRefs.length, 1);
        assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
        assert.equal(source.lifecycle.dispatchRefs[0].phase, 'dispatched');
        assert.equal(f.store.getById(f.response.id).lifecycle.status, 'processing');
        const refs = structuredClone(source.lifecycle.dispatchRefs);
        await call.observe({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'native-turn' } } });
        if (mcp) {
          const denied = await mcp.callTool({
            name: 'cat_cafe_get_thread_context',
            arguments: { responseMode: 'full' },
            _meta: meta,
          });
          assert.equal(denied.isError, true, 'completed native turn cannot reuse callback credentials');
        }
        await call.stop();
        assert.equal((await f.read()).statusCode, 409);
        assert.deepEqual(f.store.getById(f.message.id).lifecycle.dispatchRefs, refs);
        assert.equal(
          f.store.getByThread('home', 30, 'owner').filter((m) => m.lifecycle?.kind === 'response').length,
          1,
        );
      } finally {
        await mcp?.close();
        await sessions.close();
        await f.close();
      }
    },
  );
}
async function pendingSingle(f) {
  assert.deepEqual((await f.queue.getDurableEntry('home', f.entry.id)).targets, ['codex-astra']);
  assert.equal(f.store.getById(f.message.id).lifecycle.dispatchRefs?.length ?? 0, 0);
}
