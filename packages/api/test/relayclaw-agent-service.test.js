import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { RelayClawAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/RelayClawAgentService.js'
);

describe('RelayClawAgentService', () => {
  it('emits final text when the stream only returns chat.final content', async () => {
    const service = new RelayClawAgentService({
      catId: 'relayclaw-debug',
      config: {
        url: 'ws://127.0.0.1:65535',
        autoStart: false,
      },
    });

    service.ensureConnected = async () => {};
    service.ws = {
      readyState: globalThis.WebSocket?.OPEN ?? 1,
      send: (raw) => {
        const request = JSON.parse(raw);
        const queue = service.requestQueues.get(request.request_id);
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
      },
    };

    const messages = [];
    for await (const msg of service.invoke('Reply with exactly: OK')) {
      messages.push(msg);
    }

    assert.deepEqual(
      messages.map((msg) => msg.type),
      ['session_init', 'text', 'done'],
    );
    assert.equal(messages[1].content, 'OK');
  });

  it('waits for jiuwenclaw initialization markers before treating the sidecar as ready', () => {
    const service = new RelayClawAgentService({
      catId: 'relayclaw-debug',
      config: {
        url: 'ws://127.0.0.1:65535',
        autoStart: false,
      },
    });

    service.recentLogs = 'server listening';
    assert.equal(service.isSidecarReady(), false);

    service.recentLogs = '[JiuWenClaw] 初始化完成: agent_name=main_agent';
    assert.equal(service.isSidecarReady(), true);

    service.recentLogs = 'WebChannel 已启动: ws://127.0.0.1:19001/ws';
    assert.equal(service.isSidecarReady(), true);
  });

  it('passes project directory, uploaded files, and cat-cafe MCP config in the WS request', async () => {
    const service = new RelayClawAgentService({
      catId: 'relayclaw-debug',
      config: {
        url: 'ws://127.0.0.1:65535',
        autoStart: false,
      },
    });

    service.ensureConnected = async () => {};
    let capturedRequest = null;
    service.ws = {
      readyState: globalThis.WebSocket?.OPEN ?? 1,
      send: (raw) => {
        capturedRequest = JSON.parse(raw);
        const queue = service.requestQueues.get(capturedRequest.request_id);
        assert.ok(queue, 'request queue should exist before send');
        queue.put({
          request_id: capturedRequest.request_id,
          channel_id: capturedRequest.channel_id,
          payload: { is_complete: true },
          is_complete: true,
        });
      },
    };

    const blocks = [{ type: 'image', url: '/uploads/test-image.png' }];
    for await (const _ of service.invoke('Inspect the uploaded image', {
      workingDirectory: '/usr/code/cat-cafe-runtime',
      uploadDir: '/tmp/cat-cafe-uploads',
      contentBlocks: blocks,
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
});
