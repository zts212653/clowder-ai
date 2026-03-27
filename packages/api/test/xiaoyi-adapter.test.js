import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { generateXiaoyiSignature, XiaoyiAdapter } from '../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js';

function noopLog() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  };
}

function makeAdapter(overrides = {}) {
  return new XiaoyiAdapter(noopLog(), {
    ak: 'test-ak',
    sk: 'test-sk',
    agentId: 'agent_001',
    ...overrides,
  });
}

// ── HMAC-SHA256 Signature ──

describe('generateXiaoyiSignature', () => {
  it('produces HMAC-SHA256 base64 (not hex)', () => {
    const ts = '1710000000000';
    const sk = 'my-secret-key';
    const expected = createHmac('sha256', sk).update(ts).digest('base64');
    assert.equal(generateXiaoyiSignature(sk, ts), expected);
  });

  it('returns base64 string (contains +, /, = characters)', () => {
    const sig = generateXiaoyiSignature('key', '12345');
    // Base64 output, not hex — should not be purely [0-9a-f]
    assert.ok(sig.length > 0);
    // SHA-256 base64 is always 44 chars
    assert.equal(sig.length, 44);
  });

  it('different timestamps produce different signatures', () => {
    const sig1 = generateXiaoyiSignature('sk', '1000');
    const sig2 = generateXiaoyiSignature('sk', '2000');
    assert.notEqual(sig1, sig2);
  });
});

// ── XiaoyiAdapter basics ──

describe('XiaoyiAdapter', () => {
  describe('connectorId', () => {
    it('is xiaoyi', () => {
      assert.equal(makeAdapter().connectorId, 'xiaoyi');
    });
  });

  // ── Inbound message parsing (via handleRawMessage) ──
  // We test the private handleRawMessage indirectly through startConnection + simulated WS messages.
  // Since we can't connect to a real WS in unit tests, we test the exported protocol helpers
  // and the adapter's public interface.

  describe('sendReply() without active session', () => {
    it('drops reply silently when no session is tracked', async () => {
      const adapter = makeAdapter();
      // No startConnection, no sessions — sendReply should not throw
      await adapter.sendReply('session_unknown', 'Hello');
    });
  });
});

// ── A2A Protocol helpers (tested via adapter's internal message handling) ──
// The protocol builder functions are module-private, but we verify their behavior
// through the adapter's inbound→outbound flow in integration tests.
// Here we test what we can access: signature + adapter identity.

describe('XiaoyiAdapter ConnectorDefinition alignment', () => {
  it('connectorId matches the registry entry id "xiaoyi"', () => {
    const adapter = makeAdapter();
    assert.equal(adapter.connectorId, 'xiaoyi');
  });
});

// ── Inbound message parsing (exported parseA2AMessageParts is private, ──
// ── so we test via the adapter's message handler using a test harness)  ──

describe('XiaoyiAdapter inbound message parsing', () => {
  /**
   * Helper: simulate receiving a raw WS message through the adapter.
   * We access the private handleRawMessage via prototype to test parsing
   * without needing a real WebSocket connection.
   */
  function simulateInbound(adapter, raw) {
    const ch = {
      ws: null,
      url: 'wss://test',
      label: 'test',
      heartbeatTimer: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      initSent: false,
    };
    // Call private method via bracket notation
    adapter['handleRawMessage'](ch, typeof raw === 'string' ? raw : JSON.stringify(raw));
  }

  it('parses message/stream with text part and invokes onMessage', async () => {
    const adapter = makeAdapter();
    const received = [];
    adapter.startConnection = undefined; // prevent real WS
    // Directly wire the callback
    adapter['onMessage'] = async (msg) => {
      received.push(msg);
    };
    adapter['running'] = true;

    simulateInbound(adapter, {
      msgType: 'message/stream',
      sessionId: 'sess_001',
      params: {
        id: 'task_001',
        sessionId: 'sess_001',
        message: {
          role: 'user',
          parts: [{ kind: 'text', text: '你好小艺' }],
        },
      },
    });

    // Wait for async handler
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].chatId, 'sess_001');
    assert.equal(received[0].text, '你好小艺');
    assert.equal(received[0].taskId, 'task_001');
    assert.equal(received[0].messageId, 'task_001');
  });

  it('parses file attachments from message parts', async () => {
    const adapter = makeAdapter();
    const received = [];
    adapter['onMessage'] = async (msg) => {
      received.push(msg);
    };
    adapter['running'] = true;

    simulateInbound(adapter, {
      msgType: 'message/stream',
      sessionId: 'sess_002',
      params: {
        id: 'task_002',
        sessionId: 'sess_002',
        message: {
          role: 'user',
          parts: [
            { kind: 'text', text: '看看这张图' },
            { kind: 'file', file: { uri: 'https://example.com/img.png', name: 'photo.png', mimeType: 'image/png' } },
          ],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].text, '看看这张图');
    assert.ok(received[0].attachments);
    assert.equal(received[0].attachments.length, 1);
    assert.equal(received[0].attachments[0].type, 'image');
    assert.equal(received[0].attachments[0].url, 'https://example.com/img.png');
    assert.equal(received[0].attachments[0].fileName, 'photo.png');
  });

  it('deduplicates messages with same taskId across dual channels', async () => {
    const adapter = makeAdapter();
    const received = [];
    adapter['onMessage'] = async (msg) => {
      received.push(msg);
    };
    adapter['running'] = true;

    const msg = {
      msgType: 'message/stream',
      sessionId: 'sess_003',
      params: {
        id: 'task_003',
        sessionId: 'sess_003',
        message: { role: 'user', parts: [{ kind: 'text', text: 'dedup test' }] },
      },
    };

    // Simulate same message arriving on both channels
    simulateInbound(adapter, msg);
    simulateInbound(adapter, msg);

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1, 'Duplicate message should be deduplicated');
  });

  it('skips empty messages (no text, no files)', async () => {
    const adapter = makeAdapter();
    const received = [];
    adapter['onMessage'] = async (msg) => {
      received.push(msg);
    };
    adapter['running'] = true;

    simulateInbound(adapter, {
      msgType: 'message/stream',
      sessionId: 'sess_004',
      params: {
        id: 'task_004',
        sessionId: 'sess_004',
        message: { role: 'user', parts: [] },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 0, 'Empty messages should be skipped');
  });

  it('ignores heartbeat messages', async () => {
    const adapter = makeAdapter();
    const received = [];
    adapter['onMessage'] = async (msg) => {
      received.push(msg);
    };
    adapter['running'] = true;

    simulateInbound(adapter, { msgType: 'heartbeat' });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 0);
  });

  it('handles clearContext without error', () => {
    const adapter = makeAdapter();
    adapter['running'] = true;
    // Should not throw
    simulateInbound(adapter, { method: 'clearContext', sessionId: 'sess_005' });
  });

  it('handles tasks/cancel and clears session mapping', async () => {
    const adapter = makeAdapter();
    adapter['onMessage'] = async () => {};
    adapter['running'] = true;

    // First, create a session mapping via inbound message
    simulateInbound(adapter, {
      msgType: 'message/stream',
      sessionId: 'sess_006',
      params: {
        id: 'task_006',
        sessionId: 'sess_006',
        message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
      },
    });

    // Verify session exists
    assert.equal(adapter['sessionMap'].get('task_006'), 'sess_006');

    // Cancel the task
    simulateInbound(adapter, { method: 'tasks/cancel', params: { id: 'task_006' } });

    // Session mapping should be removed
    assert.equal(adapter['sessionMap'].has('task_006'), false);
  });

  it('handles non-JSON messages gracefully', () => {
    const adapter = makeAdapter();
    adapter['running'] = true;
    // Should not throw
    simulateInbound(adapter, 'not valid json {{{');
  });

  it('parses audio file attachments correctly', async () => {
    const adapter = makeAdapter();
    const received = [];
    adapter['onMessage'] = async (msg) => {
      received.push(msg);
    };
    adapter['running'] = true;

    simulateInbound(adapter, {
      msgType: 'message/stream',
      sessionId: 'sess_007',
      params: {
        id: 'task_007',
        sessionId: 'sess_007',
        message: {
          role: 'user',
          parts: [
            { kind: 'text', text: '听这个' },
            { kind: 'file', file: { uri: 'https://example.com/voice.mp3', mimeType: 'audio/mpeg' } },
          ],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received[0].attachments[0].type, 'audio');
  });
});
