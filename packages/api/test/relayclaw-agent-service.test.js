import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { RelayClawAgentService, __relayClawInternals } = await import(
  '../dist/domains/cats/services/agents/providers/RelayClawAgentService.js'
);

function createConnectionFactory(onSend) {
  return (requestQueues) => ({
    async ensureConnected() {},
    isOpen() {
      return true;
    },
    send(payload) {
      onSend(payload, requestQueues);
    },
    close() {},
  });
}

describe('RelayClawAgentService', () => {
  it('emits final text when the stream only returns chat.final content', async () => {
    const service = new RelayClawAgentService(
      {
        catId: 'relayclaw-debug',
        config: {
          url: 'ws://127.0.0.1:65535',
          autoStart: false,
        },
      },
      {
        createConnection: createConnectionFactory((request, requestQueues) => {
          const queue = requestQueues.get(request.request_id);
          assert.ok(queue, 'request queue should exist before send');
          queue.put({
            request_id: request.request_id,
            channel_id: request.channel_id,
            payload: {
              event_type: 'chat.final',
              content: 'OK',
            },
            is_complete: false,
          });
          queue.put({
            request_id: request.request_id,
            channel_id: request.channel_id,
            payload: { is_complete: true },
            is_complete: true,
          });
        }),
      },
    );

    const messages = [];
    for await (const msg of service.invoke('Reply with exactly: OK')) {
      messages.push(msg);
    }

    assert.deepEqual(messages.map((msg) => msg.type), ['session_init', 'text', 'done']);
    assert.equal(messages[1].content, 'OK');
  });

  it('waits for jiuwenclaw initialization markers before treating the sidecar as ready', () => {
    assert.equal(__relayClawInternals.isSidecarReady('server listening'), false);
    assert.equal(__relayClawInternals.isSidecarReady('[JiuWenClaw] 初始化完成: agent_name=main_agent'), true);
    assert.equal(__relayClawInternals.isSidecarReady('WebChannel 已启动: ws://127.0.0.1:19001/ws'), true);
  });

  it('passes project directory, uploaded files, and cat-cafe MCP config in the WS request', async () => {
    let capturedRequest = null;
    const service = new RelayClawAgentService(
      {
        catId: 'relayclaw-debug',
        config: {
          url: 'ws://127.0.0.1:65535',
          autoStart: false,
        },
      },
      {
        createConnection: createConnectionFactory((request, requestQueues) => {
          capturedRequest = request;
          const queue = requestQueues.get(request.request_id);
          assert.ok(queue, 'request queue should exist before send');
          queue.put({
            request_id: request.request_id,
            channel_id: request.channel_id,
            payload: { is_complete: true },
            is_complete: true,
          });
        }),
      },
    );

    for await (const _ of service.invoke('Inspect the uploaded image', {
      workingDirectory: '/usr/code/cat-cafe-runtime',
      uploadDir: '/tmp/cat-cafe-uploads',
      contentBlocks: [{ type: 'image', url: '/uploads/test-image.png' }],
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
        CAT_CAFE_INVOCATION_ID: 'invocation-123',
        CAT_CAFE_CALLBACK_TOKEN: 'callback-token',
        CAT_CAFE_USER_ID: 'codex',
        CAT_CAFE_CAT_ID: 'relayclaw-debug',
      },
    })) {
      // exhaust stream
    }

    assert.ok(capturedRequest);
    assert.equal(capturedRequest.params.project_dir, '/usr/code/cat-cafe-runtime');
    assert.deepEqual(capturedRequest.params.files, {
      uploaded: [
        {
          type: 'image',
          name: 'test-image.png',
          path: '/tmp/cat-cafe-uploads/test-image.png',
        },
      ],
    });
    assert.equal(capturedRequest.params.cat_cafe_mcp.command, 'node');
    assert.ok(Array.isArray(capturedRequest.params.cat_cafe_mcp.args));
    assert.ok(
      capturedRequest.params.cat_cafe_mcp.args[0].endsWith('/packages/mcp-server/dist/index.js'),
      'cat-cafe MCP should point at the local MCP server bundle',
    );
    assert.equal(capturedRequest.params.cat_cafe_mcp.env.CAT_CAFE_INVOCATION_ID, 'invocation-123');
    assert.match(capturedRequest.params.query, /\[Local image path: \/tmp\/cat-cafe-uploads\/test-image\.png\]/);
  });

  it('yields error before done when the provider times out', async () => {
    const service = new RelayClawAgentService(
      {
        catId: 'relayclaw-debug',
        config: {
          url: 'ws://127.0.0.1:65535',
          autoStart: false,
          timeoutMs: 10,
        },
      },
      {
        createConnection: createConnectionFactory(() => {
          // Intentionally never emits frames.
        }),
      },
    );

    const messages = [];
    for await (const msg of service.invoke('This will time out')) {
      messages.push(msg);
    }

    assert.deepEqual(messages.map((msg) => msg.type), ['session_init', 'error', 'done']);
    assert.match(messages[1].error, /timed out/i);
  });

  it('yields error before done when the websocket closes unexpectedly', async () => {
    const service = new RelayClawAgentService(
      {
        catId: 'relayclaw-debug',
        config: {
          url: 'ws://127.0.0.1:65535',
          autoStart: false,
        },
      },
      {
        createConnection: createConnectionFactory((request, requestQueues) => {
          const queue = requestQueues.get(request.request_id);
          assert.ok(queue, 'request queue should exist before send');
          queue.put({
            channel_id: '',
            payload: {
              event_type: 'chat.error',
              error: 'jiuwenClaw WebSocket connection closed unexpectedly',
              is_complete: true,
            },
            is_complete: true,
          });
          queue.abort();
        }),
      },
    );

    const messages = [];
    for await (const msg of service.invoke('This will close')) {
      messages.push(msg);
    }

    assert.deepEqual(messages.map((msg) => msg.type), ['session_init', 'error', 'done']);
    assert.match(messages[1].error, /connection closed unexpectedly/i);
  });
});
