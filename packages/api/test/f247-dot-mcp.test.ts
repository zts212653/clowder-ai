import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId, deploymentDefaults } from '@cat-cafe/shared';
import Fastify from 'fastify';
import sharp from 'sharp';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MemoryCloudReturnGrantStore } from '../src/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { DotConnectionService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import { DotConnectionTestService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionTestService.js';
import { DotDispatchStore } from '../src/domains/cats/services/cloud-bridge/dot/DotDispatchStore.js';
import { DotEventsBridge } from '../src/domains/cats/services/cloud-bridge/dot/DotEventsBridge.js';
import { DotImageService } from '../src/domains/cats/services/cloud-bridge/dot/DotImageService.js';
import { DotReturnService } from '../src/domains/cats/services/cloud-bridge/dot/DotReturnService.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { readPublishedMessageItem } from '../src/domains/video-studio/content-owner/published-message-media.js';
import type { SocketManager } from '../src/infrastructure/websocket/index.js';
import { callbacksRoutes } from '../src/routes/callbacks.js';
import { registerDotImageRoutes } from '../src/routes/chatgpt-dot-image-routes.js';
import { registerDotMcpRoutes } from '../src/routes/chatgpt-dot-mcp-routes.js';
import { sharedRemote } from './helpers/f247-shared-remote.js';

test('installed Pro connection → dot events → canonical reply and private original, without a second connection', async () => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  const directory = await mkdtemp(join(tmpdir(), 'dot-mcp-'));
  const app = Fastify();
  let network: Awaited<ReturnType<typeof sharedRemote>> | undefined;
  try {
    const messages = new MessageStore();
    const threads = new ThreadStore();
    const keys = new AgentKeyRegistry();
    const grants = new MemoryCloudReturnGrantStore();
    const dispatches = new DotDispatchStore(join(directory, 'events'));
    let installed = true;
    const connection = new DotConnectionService({
      keys,
      store: new DotConnectionStore(join(directory, 'connection.json')),
      authority: async () => (installed ? { ownerUserId: 'owner', pluginInstanceId: 'dot-instance' } : null),
      ensureIdentity: async () => {},
      sendWebhook: async (_url, _headers, body) => ({
        status: 200,
        body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
      }),
    });
    const setup = await connection.begin('owner');
    const pro = await keys.issue(createCatId('gpt-pro'), 'owner');
    const returns = new DotReturnService({
      connection,
      dispatches,
      messages,
      threads,
      postReply: async (input) => {
        const result = await app.inject({
          method: 'POST',
          url: '/api/callbacks/post-message',
          headers: { 'x-agent-key-secret': input.secret, 'x-cat-cafe-dot-event-id': input.eventId },
          payload: { threadId: input.threadId, replyTo: input.sourceMessageId, content: input.content },
        });
        assert.equal(result.statusCode, 200, result.payload);
        return { messageId: result.json().messageId as string };
      },
    });
    const images = new DotImageService({
      directory: join(directory, 'images'),
      returns,
      connection,
      dispatches,
      messages,
      threads,
      emit: () => {},
    });
    app.addHook('onRequest', async (request) => {
      if (typeof request.headers['x-test-user'] === 'string') request.sessionUserId = request.headers['x-test-user'];
    });
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      agentKeyRegistry: keys,
      cloudReturnGrantStore: grants,
      messageStore: messages,
      threadStore: threads,
      admitDotReturn: (input) => returns.admitReturn(input),
      socketManager: { broadcastAgentMessage: () => {}, emitToUser: () => {} } as unknown as SocketManager,
    });
    registerDotMcpRoutes(app, { connection, returns, publishImage: (secret, input) => images.publish(secret, input) });
    registerDotImageRoutes(app, images);
    network = await sharedRemote(app, directory, pro.secret);
    const denied = async (secret: string, extra: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/plugins/chatgpt-dot/shared-mcp',
        headers: { 'x-agent-key-secret': secret, ...extra },
        payload: { jsonrpc: '2.0', id: 1, method: 'events/list' },
      });
    for (const candidate of [
      setup.credentialSecret,
      (await keys.issue(createCatId('codex61-sol'), 'owner')).secret,
      'invalid',
    ])
      assert.equal((await denied(candidate)).statusCode, 403);
    for (const extra of [
      { 'x-invocation-id': 'inherited' },
      { 'x-callback-token': 'inherited' },
      { authorization: `Bearer ${setup.credentialSecret}` },
    ])
      assert.equal((await denied(pro.secret, extra)).statusCode, 403);
    const rpc = async (method: string, params: unknown, secret = pro.secret) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/plugins/chatgpt-dot/shared-mcp',
        headers: { 'x-agent-key-secret': secret },
        payload: { jsonrpc: '2.0', id: 1, method, params },
      });
      assert.equal(response.statusCode, 200, response.payload);
      return response.json();
    };
    const originalBrand = deploymentDefaults.brand.displayName;
    try {
      deploymentDefaults.brand.displayName = 'Fixture Dot Product';
      assert.equal((await rpc('initialize', {})).result.serverInfo.name, 'Fixture Dot Product dot');
    } finally {
      deploymentDefaults.brand.displayName = originalBrand;
    }
    assert.deepEqual((await rpc('server/discover', {})).result.supportedVersions, ['2026-07-28']);
    assert.equal((await rpc('events/list', {})).result.events[0].name, 'dot.summoned');
    assert.ok(
      (await rpc('tools/list', {})).result.tools.some((tool: { name: string }) => tool.name === 'cat_cafe_dot_ask'),
      'the shared connection must expose the bounded dot author capability',
    );
    const subscription = await rpc('events/subscribe', {
      name: 'dot.summoned',
      arguments: {
        attempt_id: setup.attemptId,
        pairing_code: setup.pairingCode,
      },
      delivery: {
        mode: 'webhook',
        url: 'https://example.com/callback',
        secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      },
    });
    assert.ok(subscription.result.id);
    const foreign = await keys.issue(createCatId('gpt-pro'), 'another-owner');
    const crossOwner = await rpc(
      'events/subscribe',
      {
        name: 'dot.summoned',
        arguments: { attempt_id: setup.attemptId, pairing_code: setup.pairingCode },
        delivery: {
          mode: 'webhook',
          url: 'https://example.com/other',
          secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
        },
      },
      foreign.secret,
    );
    assert.ok(crossOwner.error, 'a real Pro key for another owner cannot borrow this dot');
    assert.equal(JSON.stringify(subscription).includes(setup.credentialSecret), false);
    const legacy = await app.inject({
      method: 'POST',
      url: '/api/plugins/chatgpt-dot/mcp',
      headers: { authorization: `Bearer ${setup.credentialSecret}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.equal(legacy.statusCode, 200, 'existing dedicated dot credentials remain compatible');
    const delivered: Array<{ eventId: string; data: { thread_id: string } }> = [];
    const bridge = new DotEventsBridge({
      connection,
      dispatches,
      messageStore: messages,
      threadStore: threads,
      enabled: async () => true,
      sendWebhook: async (_url, _headers, body) => {
        delivered.push(JSON.parse(body));
        return { status: 202, body: '{}' };
      },
    });
    const sources = await Promise.all(
      ['A', 'B'].map(async (name) => {
        const thread = threads.create('owner', name);
        const source = messages.append({
          threadId: thread.id,
          userId: 'owner',
          from: { kind: 'user', userId: 'owner' },
          content: `nonce ${name}`,
          mentions: [],
          timestamp: Date.now(),
        });
        const input = {
          catId: 'gpt-dot',
          userId: 'owner',
          threadId: thread.id,
          sourceMessageId: source.id,
          content: source.content,
          dispatchInvocationId: `inv-${name}`,
        };
        await grants.issue({
          threadId: thread.id,
          userId: 'owner',
          sourceMessageId: source.id,
          dispatchInvocationId: `unfulfilled-${name}`,
          targetCatId: 'gpt-dot',
        });
        await grants.issue({
          threadId: thread.id,
          userId: 'owner',
          sourceMessageId: source.id,
          dispatchInvocationId: `inv-${name}`,
          targetCatId: 'gpt-dot',
        });
        return input;
      }),
    );
    await Promise.all(sources.map((source) => bridge.dispatch(source)));
    for (const url of [
      '/api/callbacks/list-threads',
      `/api/callbacks/thread-context?threadId=${sources[0]!.threadId}`,
    ]) {
      const escaped = await app.inject({ url, headers: { 'x-agent-key-secret': setup.credentialSecret } });
      assert.equal(escaped.statusCode, 403, 'dot reads require the source-bound facade');
    }
    assert.equal(
      (await app.inject({ url: '/api/callbacks/list-threads', headers: { 'x-agent-key-secret': pro.secret } }))
        .statusCode,
      200,
    );
    const metadata = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const call = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args, _meta: metadata });
    const viaRemote = (name: string, args: unknown) => network!.rpc('tools/call', { name, arguments: args });
    const eventA = delivered.find((event) => event.data.thread_id === sources[0]!.threadId)!.eventId;
    const eventB = delivered.find((event) => event.data.thread_id === sources[1]!.threadId)!.eventId;
    const beforeRead = await call('cat_cafe_dot_reply', { event_id: eventA, content: 'reply' });
    assert.equal(
      beforeRead.error?.code,
      -32000,
      'metadata must reach source authorization rather than schema rejection',
    );
    assert.equal(beforeRead.error.data.reason, 'dot_source_not_read');
    assert.ok((await call('cat_cafe_dot_read_source', { event_id: eventA, catId: 'gpt-pro' })).error);
    await Promise.all(delivered.map((event) => viaRemote('cat_cafe_dot_read_source', { event_id: event.eventId })));
    const standaloneRead = await app.inject({
      method: 'POST',
      url: '/api/plugins/chatgpt-dot/mcp',
      headers: { authorization: `Bearer ${setup.credentialSecret}` },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'cat_cafe_dot_read_source', arguments: { event_id: eventA }, _meta: metadata },
      },
    });
    assert.equal(standaloneRead.json().error, undefined, 'standalone MCP accepts protocol metadata');
    assert.equal(standaloneRead.json().result.structuredContent.source.id, sources[0]!.sourceMessageId);
    const bytes = await sharp({ create: { width: 16, height: 13, channels: 4, background: '#D4835A' } })
      .png()
      .toBuffer();
    const replies = await Promise.all([
      ...[eventA, eventB].map((eventId) =>
        viaRemote('cat_cafe_dot_reply', { event_id: eventId, content: `reply ${eventId}` }),
      ),
      viaRemote('cat_cafe_dot_publish_image', {
        event_id: eventB,
        publication_key: 'concurrent-original',
        png_base64: bytes.toString('base64'),
      }),
    ]);
    assert.ok(replies.every((reply) => !reply.error));
    assert.equal(replies[2].result.structuredContent.messageId, replies[1].result.structuredContent.messageId);
    const messageA = messages.getById(replies[0].result.structuredContent.messageId);
    assert.equal(messageA?.catId, 'gpt-dot');
    assert.equal(messageA?.replyTo, sources[0]!.sourceMessageId);
    assert.equal(messages.getById(replies[1].result.structuredContent.messageId)?.threadId, sources[1]!.threadId);
    const raw = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': setup.credentialSecret },
      payload: { threadId: sources[0]!.threadId, content: 'unbound' },
    });
    assert.equal(raw.statusCode, 403);
    const cross = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': setup.credentialSecret, 'x-cat-cafe-dot-event-id': eventB },
      payload: { threadId: sources[0]!.threadId, replyTo: sources[0]!.sourceMessageId, content: 'wrong source' },
    });
    assert.equal(cross.statusCode, 403);
    const imageInput = { event_id: eventA, publication_key: 'original-image', png_base64: bytes.toString('base64') };
    const image = (await call('cat_cafe_dot_publish_image', imageInput)).result.structuredContent;
    const duplicate = (await call('cat_cafe_dot_publish_image', imageInput)).result.structuredContent;
    assert.equal(image.messageId, messageA?.id);
    assert.equal(duplicate.publicationId, image.publicationId);
    assert.equal(messages.getById(image.messageId)?.extra?.rich?.blocks?.length, 1);
    assert.equal((await app.inject({ url: image.url })).statusCode, 401);
    assert.equal((await app.inject({ url: image.url, headers: { 'x-test-user': 'stranger' } })).statusCode, 404);
    const original = await app.inject({ url: image.url, headers: { 'x-test-user': 'owner' } });
    assert.equal(original.statusCode, 200);
    assert.equal(original.rawPayload.equals(bytes), true);
    const published = await readPublishedMessageItem(
      messages,
      {
        kind: 'message',
        threadId: sources[0]!.threadId,
        messageId: image.messageId,
        messageRevision: String(messageA!.timestamp),
        item: { kind: 'media-gallery', blockId: image.publicationId, itemIndex: 0 },
        expectedUrl: image.url,
      },
      { userId: 'owner', actor: { kind: 'human', actorId: 'owner' } },
    );
    assert.equal(published.privateImageId, image.publicationId);
    const testOptions = {
      connection,
      dispatches,
      bridge,
      messages,
      threads,
      grants,
      projectPath: '/isolated-test-project',
    };
    const setupTests = new DotConnectionTestService(testOptions);
    const [firstTest, sameTest] = await Promise.all([setupTests.run('owner'), setupTests.run('owner')]);
    assert.deepEqual(firstTest, sameTest);
    assert.equal(delivered.length, 4, 'two owner setup sources are admitted once');
    const testIds = (await connection.current())!.testEventIds;
    assert.equal(testIds.length, 2);
    for (const id of testIds) {
      const read = (await call('cat_cafe_dot_read_source', { event_id: id })).result.structuredContent;
      const nonce = /随机标识 ([a-f0-9]{16})/.exec(read.source.content)![1];
      assert.equal(
        (await call('cat_cafe_dot_reply', { event_id: id, content: 'wrong nonce' })).error.data.reason,
        'dot_test_nonce_mismatch',
      );
      assert.ok((await call('cat_cafe_dot_reply', { event_id: id, content: `收到 ${nonce}` })).result);
    }
    await new DotConnectionTestService(testOptions).run('owner');
    assert.equal(delivered.length, 4, 'restart/retry reuses the same two sources and completed deliveries');
    await connection.disconnect('owner');
    assert.equal((await app.inject({ url: image.url, headers: { 'x-test-user': 'owner' } })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/plugins/chatgpt-dot/mcp',
          headers: { authorization: `Bearer ${setup.credentialSecret}` },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        })
      ).statusCode,
      403,
    );
    installed = false;
    assert.equal(
      (await rpc('events/list', {})).result.events[0].name,
      'dot.summoned',
      'uninstalled dot does not break shared metadata',
    );
    assert.ok((await call('cat_cafe_dot_read_source', { event_id: eventA })).error);
    assert.equal((await keys.verify(pro.secret)).ok, true);
    installed = true;
    await connection.disconnect('owner');
    assert.ok((await call('cat_cafe_dot_read_source', { event_id: eventA })).error);
    assert.equal((await keys.verify(pro.secret)).ok, true, 'dot revocation preserves the existing Pro key');
    await keys.revoke(pro.agentKeyId, 'test');
    assert.equal((await denied(pro.secret)).statusCode, 403);
  } finally {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    await network?.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
