import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';

for (const sourceWriter of [false, true]) {
  test(`dot credentials cannot enter generic callback routes; source writer opt-in=${sourceWriter}`, async () => {
    const keys = new AgentKeyRegistry();
    const dot = await keys.issue(createCatId('gpt-dot'), 'owner', { expiresAt: null });
    const pro = await keys.issue(createCatId('gpt-pro'), 'owner', { scope: 'cloud-conversation' });
    const app = Fastify();
    let handled = 0;
    registerCallbackAuthHook(app, new InvocationRegistry(), {
      agentKeyRegistry: keys,
      ...(sourceWriter ? { allowDotSourceBoundReturn: true } : {}),
    });
    const routes = [
      ['GET', '/api/callbacks/list-threads'],
      ['GET', '/api/callbacks/thread-context'],
      ['POST', '/api/callbacks/update-task'],
      ['GET', '/api/workspace/read'],
      ['GET', '/api/callbacks/post-message'],
    ] as const;
    for (const [method, url] of [...routes, ['POST', '/api/callbacks/post-message'] as const]) {
      app.route({
        method,
        url,
        handler: async () => {
          handled += 1;
          return { ok: true };
        },
      });
    }
    try {
      for (const [method, url] of routes) {
        const result = await app.inject({ method, url, headers: { 'x-agent-key-secret': dot.secret } });
        assert.equal(result.statusCode, 403, `${method} ${url} must reject the dot facade credential`);
      }
      assert.equal(handled, 0, 'no protected handler runs before the scope rejection');
      const post = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-agent-key-secret': dot.secret },
      });
      assert.equal(
        post.statusCode,
        sourceWriter ? 200 : 403,
        'only the explicitly admitted writer reaches its own guard',
      );
      const legacy = await app.inject({
        method: 'GET',
        url: '/api/callbacks/list-threads',
        headers: { 'x-agent-key-secret': pro.secret },
      });
      assert.equal(
        legacy.statusCode,
        200,
        'Pro retains its callback contract with the current cloud-conversation credential',
      );
    } finally {
      await app.close();
    }
  });
}
