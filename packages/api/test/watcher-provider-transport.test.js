import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

test(
  'the native provider boundary keeps its loopback hop local and retains the upstream outer proxy',
  { timeout: 30000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w);
    const proxied = [];
    const proxy = createServer(async (request, reply) => {
      proxied.push(request.url);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(`${f.apiUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.concat(chunks),
      });
      reply.writeHead(upstream.status, { 'content-type': 'text/event-stream' });
      for await (const chunk of upstream.body) reply.write(chunk);
      reply.end();
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${proxy.address().port}`;
    f.state.nativeEnv = {
      OPENAI_BASE_URL: 'http://watcher-provider.invalid/v1',
      HTTP_PROXY: endpoint,
      http_proxy: endpoint,
      HTTPS_PROXY: endpoint,
      https_proxy: endpoint,
      ALL_PROXY: endpoint,
      all_proxy: endpoint,
      NO_PROXY: 'existing.example',
      no_proxy: 'another.example',
    };
    try {
      const [source] = await w.work('RAW_INCREMENT_14');
      const session = await f.run(source, AbortSignal.timeout(20000));
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.deepEqual(proxied, ['http://watcher-provider.invalid/v1/responses']);
      assert.equal(f.requests.length, 1);
      assert.equal(
        Object.values(
          (await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`))[0].watcherModelAttempts,
        ).length,
        1,
      );
    } finally {
      await f.close();
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
  },
);
