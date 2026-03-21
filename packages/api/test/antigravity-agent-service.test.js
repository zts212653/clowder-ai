import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import {
  AntigravityAgentService,
  resolveAntigravityCdpPort,
} from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';

async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

/** Create a fake CDP client for testing */
function createMockCdpClient({ response = { text: 'Meow!' }, connectError = null } = {}) {
  return {
    connected: false,
    connect: mock.fn(async () => {
      if (connectError) throw new Error(connectError);
    }),
    disconnect: mock.fn(async () => {
      /* noop */
    }),
    sendMessage: mock.fn(async () => {
      /* noop */
    }),
    pollResponse: mock.fn(async () => response),
    newConversation: mock.fn(async () => {
      /* noop */
    }),
    switchModel: mock.fn(async () => {
      /* noop */
    }),
    getCurrentModel: mock.fn(async () => null),
  };
}

describe('AntigravityAgentService', () => {
  test('resolves CDP port from antigravity command args', () => {
    assert.equal(resolveAntigravityCdpPort(['.', '--remote-debugging-port=9010']), 9010);
    assert.equal(resolveAntigravityCdpPort(['.', '--remote-debugging-port', '9020']), 9020);
    assert.equal(resolveAntigravityCdpPort(['.', '--remote-debugging-port', 'invalid']), undefined);
    assert.equal(resolveAntigravityCdpPort(['.', '--remote-debugging-port=99999']), undefined);
  });

  test('yields text + done from successful response', async () => {
    const cdpClient = createMockCdpClient({ response: { text: 'Hello from Antigravity!' } });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      cdpClient,
    });
    const messages = await collect(service.invoke('Say hello'));

    // Should connect, create new conversation, send, poll
    assert.equal(cdpClient.connect.mock.callCount(), 1);
    assert.equal(cdpClient.newConversation.mock.callCount(), 1);
    assert.equal(cdpClient.sendMessage.mock.callCount(), 1);
    assert.equal(cdpClient.sendMessage.mock.calls[0].arguments[0], 'Say hello');
    assert.equal(cdpClient.pollResponse.mock.callCount(), 1);

    // Message sequence: text → done
    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, 'text');
    assert.equal(messages[0].content, 'Hello from Antigravity!');
    assert.equal(messages[0].catId, 'antigravity');
    assert.equal(messages[0].metadata.provider, 'antigravity');
    assert.equal(messages[0].metadata.model, 'gemini-3.1-pro');
    assert.equal(messages[1].type, 'done');
  });

  test('yields error + done when CDP connect fails', async () => {
    const cdpClient = createMockCdpClient({ connectError: 'Connection refused' });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      cdpClient,
    });
    const messages = await collect(service.invoke('test'));

    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, 'error');
    assert.ok(messages[0].error.includes('Connection refused'));
    assert.equal(messages[1].type, 'done');
  });

  test('yields error + done when poll returns null (timeout)', async () => {
    const cdpClient = createMockCdpClient({ response: null });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      cdpClient,
    });
    const messages = await collect(service.invoke('test'));

    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, 'error');
    assert.ok(messages[0].error.toLowerCase().includes('timeout'));
    assert.equal(messages[1].type, 'done');
  });

  test('disconnect is called after successful invoke', async () => {
    const cdpClient = createMockCdpClient({ response: { text: 'ok' } });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      cdpClient,
    });
    await collect(service.invoke('test'));
    assert.equal(cdpClient.disconnect.mock.callCount(), 1);
  });

  test('disconnect is called after error', async () => {
    const cdpClient = createMockCdpClient({ connectError: 'fail' });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      cdpClient,
    });
    await collect(service.invoke('test'));
    assert.equal(cdpClient.disconnect.mock.callCount(), 1);
  });

  test('skips connect if already connected', async () => {
    const cdpClient = createMockCdpClient({ response: { text: 'ok' } });
    cdpClient.connected = true;
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      cdpClient,
    });
    await collect(service.invoke('test'));
    assert.equal(cdpClient.connect.mock.callCount(), 0);
  });

  // R3: workingDirectory → titleHint derivation
  test('passes workingDirectory-derived titleHint to connect()', async () => {
    const cdpClient = createMockCdpClient({ response: { text: 'ok' } });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      cdpClient,
    });
    await collect(service.invoke('test', { workingDirectory: '/home/user/projects/cat-cafe' }));
    assert.equal(cdpClient.connect.mock.callCount(), 1);
    assert.equal(cdpClient.connect.mock.calls[0].arguments[0], 'cat-cafe');
  });

  test('connect receives undefined titleHint when no workingDirectory', async () => {
    const cdpClient = createMockCdpClient({ response: { text: 'ok' } });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      cdpClient,
    });
    await collect(service.invoke('test'));
    assert.equal(cdpClient.connect.mock.callCount(), 1);
    assert.equal(cdpClient.connect.mock.calls[0].arguments[0], undefined);
  });

  test('Bug-2: invoke calls switchModel with mapped label before sending', async () => {
    const cdpClient = createMockCdpClient({ response: { text: 'ok' } });
    cdpClient.switchModel = mock.fn(async () => {
      /* noop */
    });
    cdpClient.getCurrentModel = mock.fn(async () => 'Gemini 3.1 Pro (High)');
    const service = new AntigravityAgentService({
      catId: 'antig-opus',
      model: 'claude-opus-4-6',
      cdpClient,
    });
    await collect(service.invoke('test'));
    // switchModel should be called before sendMessage
    assert.equal(cdpClient.switchModel.mock.callCount(), 1);
    // The label should be the Antigravity UI label, not the cat-config model ID
    const switchArg = cdpClient.switchModel.mock.calls[0].arguments[0];
    assert.ok(switchArg.toLowerCase().includes('opus'), `Expected opus in label, got: ${switchArg}`);
  });

  test('Bug-2: modelVerified is true after successful switchModel', async () => {
    const cdpClient = createMockCdpClient({ response: { text: 'ok' } });
    cdpClient.switchModel = mock.fn(async () => {
      /* noop */
    });
    cdpClient.getCurrentModel = mock.fn(async () => 'Claude Opus 4.6 (Thinking)');
    const service = new AntigravityAgentService({
      catId: 'antig-opus',
      model: 'claude-opus-4-6',
      cdpClient,
    });
    const messages = await collect(service.invoke('test'));
    const textMsg = messages.find((m) => m.type === 'text');
    assert.equal(textMsg.metadata.modelVerified, true);
  });

  test('P2-fix: claude-opus model maps to Opus label, not Sonnet', async () => {
    const cdpClient = createMockCdpClient({ response: { text: 'ok' } });
    cdpClient.switchModel = mock.fn(async () => {
      /* noop */
    });
    const service = new AntigravityAgentService({
      catId: 'antig-opus',
      model: 'claude-opus-4-6',
      cdpClient,
    });
    await collect(service.invoke('test'));
    const switchArg = cdpClient.switchModel.mock.calls[0].arguments[0];
    // Must contain 'Opus', must NOT be 'Sonnet'
    assert.ok(switchArg.includes('Opus'), `Expected Opus in label, got: ${switchArg}`);
    assert.ok(!switchArg.includes('Sonnet'), `Must not map to Sonnet, got: ${switchArg}`);
  });

  test('P2-fix: unknown claude model does not fallback to wrong Claude variant', async () => {
    const cdpClient = createMockCdpClient({ response: { text: 'ok' } });
    cdpClient.switchModel = mock.fn(async () => {
      /* noop */
    });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'claude-haiku-4-5', // not in MAP
      cdpClient,
    });
    const messages = await collect(service.invoke('test'));
    // switchModel should NOT be called for unmapped model (no fallback!)
    assert.equal(cdpClient.switchModel.mock.callCount(), 0, 'Must not fallback to wrong Claude variant');
    const textMsg = messages.find((m) => m.type === 'text');
    assert.equal(textMsg.metadata.modelVerified, false);
  });

  // When CDP client lacks switchModel, model remains unverified
  test('metadata marks model as unverified when CDP client has no switchModel', async () => {
    const cdpClient = createMockCdpClient({ response: { text: 'ok' } });
    delete cdpClient.switchModel;
    delete cdpClient.getCurrentModel;
    const service = new AntigravityAgentService({
      catId: 'antig-opus',
      model: 'claude-opus-4-6',
      cdpClient,
    });
    const messages = await collect(service.invoke('test'));
    const textMsg = messages.find((m) => m.type === 'text');
    assert.equal(textMsg.metadata.modelVerified, false, 'Without switchModel, model cannot be verified');
  });
});
