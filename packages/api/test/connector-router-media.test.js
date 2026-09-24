import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

function makeMockDeps(overrides = {}) {
  const messages = [];
  const triggers = [];
  return {
    bindingStore: {
      async getByExternal() {
        return { connectorId: 'feishu', externalChatId: 'chat1', threadId: 'T1', userId: 'u1', createdAt: 0 };
      },
      async getByThread() {
        return [];
      },
      async bind() {
        return { connectorId: 'feishu', externalChatId: 'chat1', threadId: 'T1', userId: 'u1', createdAt: 0 };
      },
    },
    dedup: { isDuplicate: () => false },
    messageStore: {
      async append(input) {
        messages.push(input);
        return { id: `msg-${messages.length}` };
      },
    },
    // RFC §5.1: the router hands an envelope to the one durable-admission component.
    persistedQueueDelivery: {
      async deliver(input) {
        messages.push({ ...input, mentions: [input.targetCatId], deliveryStatus: 'queued' });
        const id = `msg-${messages.length}`;
        return { state: 'started', entryId: `entry-${messages.length}`, message: { id, ...input } };
      },
    },
    threadStore: {
      create: async () => ({ id: 'T1' }),
      get: async () => ({ id: 'T1', title: 'Test' }),
      list: async () => [],
      updateConnectorHubState: async () => {},
    },
    invokeTrigger: {
      trigger: mock.fn(),
    },
    defaultUserId: 'user1',
    defaultCatId: 'opus',
    log: { info() {}, warn() {}, error() {}, debug() {} },
    _messages: messages,
    _triggers: triggers,
    ...overrides,
  };
}

describe('ConnectorRouter media handling', () => {
  it('voice attachment triggers STT and routes transcribed text', async () => {
    const { ConnectorRouter } = await import('../dist/infrastructure/connectors/ConnectorRouter.js');

    const sttTranscribe = mock.fn(async () => ({
      text: '你好猫猫',
    }));
    const mediaDownload = mock.fn(async () => ({
      localUrl: '/api/connector-media/audio.ogg',
      absPath: '/tmp/audio.ogg',
      mimeType: 'audio/ogg',
    }));

    const deps = makeMockDeps({
      mediaService: { download: mediaDownload },
      sttProvider: { transcribe: sttTranscribe },
    });

    const router = new ConnectorRouter(deps);
    const result = await router.route('feishu', 'chat1', '[语音]', 'msg1', [
      { type: 'audio', platformKey: 'audio_key_123', duration: 3 },
    ]);

    assert.equal(result.kind, 'routed');
    // Should have stored the STT transcribed text
    assert.ok(deps._messages[0].content.includes('🎤 你好猫猫'));
    assert.equal(sttTranscribe.mock.calls.length, 1);
    assert.equal(mediaDownload.mock.calls.length, 1);
  });

  it('image attachment downloads and includes URL in message', async () => {
    const { ConnectorRouter } = await import('../dist/infrastructure/connectors/ConnectorRouter.js');

    const mediaDownload = mock.fn(async () => ({
      localUrl: '/api/connector-media/photo.jpg',
      absPath: '/tmp/photo.jpg',
      mimeType: 'image/jpeg',
    }));

    const deps = makeMockDeps({ mediaService: { download: mediaDownload } });
    const router = new ConnectorRouter(deps);
    const result = await router.route('feishu', 'chat1', '[图片]', 'msg1', [
      { type: 'image', platformKey: 'img_key_456' },
    ]);

    assert.equal(result.kind, 'routed');
    assert.ok(deps._messages[0].content.includes('/api/connector-media/photo.jpg'));
    assert.equal(mediaDownload.mock.calls.length, 1);
  });

  it('routes normally when no attachments', async () => {
    const { ConnectorRouter } = await import('../dist/infrastructure/connectors/ConnectorRouter.js');

    const deps = makeMockDeps();
    const router = new ConnectorRouter(deps);
    const result = await router.route('feishu', 'chat1', '普通消息', 'msg1');

    assert.equal(result.kind, 'routed');
    assert.equal(deps._messages[0].content, '普通消息');
  });

  it('falls back to placeholder text when STT fails', async () => {
    const { ConnectorRouter } = await import('../dist/infrastructure/connectors/ConnectorRouter.js');

    const deps = makeMockDeps({
      mediaService: {
        download: async () => ({ localUrl: '/x', absPath: '/tmp/x', mimeType: 'audio/ogg' }),
      },
      sttProvider: {
        transcribe: async () => {
          throw new Error('STT service down');
        },
      },
    });

    const router = new ConnectorRouter(deps);
    const result = await router.route('feishu', 'chat1', '[语音]', 'msg1', [
      { type: 'audio', platformKey: 'key', duration: 2 },
    ]);

    assert.equal(result.kind, 'routed');
    assert.equal(deps._messages[0].content, '[语音]');
  });

  it('falls back to placeholder when media download fails', async () => {
    const { ConnectorRouter } = await import('../dist/infrastructure/connectors/ConnectorRouter.js');

    const deps = makeMockDeps({
      mediaService: {
        download: async () => {
          throw new Error('Download failed');
        },
      },
    });

    const router = new ConnectorRouter(deps);
    const result = await router.route('feishu', 'chat1', '[图片]', 'msg1', [{ type: 'image', platformKey: 'key' }]);

    assert.equal(result.kind, 'routed');
    assert.equal(deps._messages[0].content, '[图片]');
  });

  it('P1-1: image attachment carries contentBlocks with ImageContent in its envelope', async () => {
    const { ConnectorRouter } = await import('../dist/infrastructure/connectors/ConnectorRouter.js');

    const mediaDownload = mock.fn(async () => ({
      localUrl: '/api/connector-media/photo.jpg',
      absPath: '/tmp/photo.jpg',
      mimeType: 'image/jpeg',
    }));

    const deps = makeMockDeps({ mediaService: { download: mediaDownload } });
    const router = new ConnectorRouter(deps);
    await router.route('feishu', 'chat1', '[图片]', 'msg1', [{ type: 'image', platformKey: 'img_key_456' }]);

    // RFC §5.1: media parts belong to the same envelope as the text, not to a second wake call.
    const envelope = deps._messages[0];
    assert.ok(envelope, 'the input should have been admitted');
    const contentBlocks = envelope.contentBlocks;
    assert.ok(Array.isArray(contentBlocks), 'contentBlocks should be an array');
    assert.ok(contentBlocks.length > 0, 'contentBlocks should not be empty');
    assert.equal(contentBlocks[0].type, 'image');
    // #706: contentBlocks must use localUrl (public HTTP route), not absPath (filesystem leak)
    assert.equal(contentBlocks[0].url, '/api/connector-media/photo.jpg');
  });

  it('P1-1: voice attachment does not produce image contentBlocks', async () => {
    const { ConnectorRouter } = await import('../dist/infrastructure/connectors/ConnectorRouter.js');

    const deps = makeMockDeps({
      mediaService: {
        download: async () => ({
          localUrl: '/api/connector-media/a.ogg',
          absPath: '/tmp/a.ogg',
          mimeType: 'audio/ogg',
        }),
      },
      sttProvider: { transcribe: async () => ({ text: '你好' }) },
    });
    const router = new ConnectorRouter(deps);
    await router.route('feishu', 'chat1', '[语音]', 'msg1', [{ type: 'audio', platformKey: 'key', duration: 2 }]);

    const contentBlocks = deps._messages[0]?.contentBlocks;
    // Voice = STT text, no image blocks expected
    if (contentBlocks) {
      const imageBlocks = contentBlocks.filter((b) => b.type === 'image');
      assert.equal(imageBlocks.length, 0, 'voice should not produce image contentBlocks');
    }
  });

  it('ISSUE-3: image contentBlocks persisted to messageStore for queue replay', async () => {
    const { ConnectorRouter } = await import('../dist/infrastructure/connectors/ConnectorRouter.js');

    const mediaDownload = mock.fn(async () => ({
      localUrl: '/api/connector-media/photo.jpg',
      absPath: '/tmp/photo.jpg',
      mimeType: 'image/jpeg',
    }));

    const deps = makeMockDeps({ mediaService: { download: mediaDownload } });
    const router = new ConnectorRouter(deps);
    await router.route('feishu', 'chat1', '[图片]', 'msg1', [{ type: 'image', platformKey: 'img_key_789' }]);

    // The stored message must include contentBlocks so QueueProcessor can recover them on replay
    const storedMessage = deps._messages[0];
    assert.ok(storedMessage.contentBlocks, 'messageStore.append() must receive contentBlocks');
    assert.ok(Array.isArray(storedMessage.contentBlocks), 'contentBlocks must be an array');
    assert.ok(storedMessage.contentBlocks.length > 0, 'contentBlocks must not be empty');
    assert.equal(storedMessage.contentBlocks[0].type, 'image');
  });

  it('does not process attachments when no mediaService', async () => {
    const { ConnectorRouter } = await import('../dist/infrastructure/connectors/ConnectorRouter.js');

    const deps = makeMockDeps();
    const router = new ConnectorRouter(deps);
    const result = await router.route('feishu', 'chat1', '[语音]', 'msg1', [{ type: 'audio', platformKey: 'key' }]);

    assert.equal(result.kind, 'routed');
    assert.equal(deps._messages[0].content, '[语音]');
  });
});
