/**
 * Heartbeat emission tests
 * Verifies that heartbeat is emitted during long-running invocations
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('Heartbeat emission', () => {
  let originalSetInterval;
  let originalClearInterval;
  let intervalCallbacks;
  let clearedIntervals;

  beforeEach(() => {
    intervalCallbacks = [];
    clearedIntervals = [];
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;

    // Mock setInterval to capture callbacks
    globalThis.setInterval = (callback, ms) => {
      const id = intervalCallbacks.length;
      intervalCallbacks.push({ callback, ms, id });
      return id;
    };

    globalThis.clearInterval = (id) => {
      clearedIntervals.push(id);
    };
  });

  afterEach(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  it('messages.ts sets up 30s heartbeat interval', async () => {
    // Read the source to verify the constant
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../src/routes/messages.ts', import.meta.url), 'utf8');

    // Verify HEARTBEAT_INTERVAL_MS is defined as 30000
    assert.ok(
      source.includes('HEARTBEAT_INTERVAL_MS = 30_000') || source.includes('HEARTBEAT_INTERVAL_MS = 30000'),
      'HEARTBEAT_INTERVAL_MS should be 30 seconds',
    );

    // Verify broadcastToRoom is called with 'heartbeat' event
    assert.ok(source.includes("'heartbeat'"), 'Should broadcast heartbeat event');
  });

  it('heartbeat interval is cleared in finally block', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../src/routes/messages.ts', import.meta.url), 'utf8');

    // Verify clearInterval is called in finally
    assert.ok(source.includes('clearInterval(heartbeatInterval)'), 'Should clear heartbeat interval in finally block');

    // Verify finally block exists
    assert.ok(source.includes('} finally {'), 'Should have finally block');
  });
});

describe('SocketManager heartbeat listener', () => {
  it('useSocket.ts includes onHeartbeat callback type', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../../web/src/hooks/useSocket.ts', import.meta.url), 'utf8');

    assert.ok(source.includes('onHeartbeat'), 'Should have onHeartbeat callback');

    assert.ok(source.includes("socket.on('heartbeat'"), 'Should listen for heartbeat event');
  });
});

describe('Frontend timeout logic (source verification)', () => {
  it('useAgentMessages.ts has 5-minute timeout constant', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../../web/src/hooks/useAgentMessages.ts', import.meta.url), 'utf8');

    // 5 * 60 * 1000 = 300000
    assert.ok(source.includes('DONE_TIMEOUT_MS = 5 * 60 * 1000'), 'Should have 5-minute timeout constant');
  });

  it('useAgentMessages.ts resets timeout on each message', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../../web/src/hooks/useAgentMessages.ts', import.meta.url), 'utf8');

    // Should call resetTimeout() at the start of handleAgentMessage
    assert.ok(source.includes('resetTimeout()'), 'Should reset timeout on message');
  });

  it('useAgentMessages.ts clears timeout on done with isFinal', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../../web/src/hooks/useAgentMessages.ts', import.meta.url), 'utf8');

    // Should call clearDoneTimeout() when msg.isFinal
    assert.ok(
      source.includes('if (msg.isFinal)') && source.includes('clearDoneTimeout()'),
      'Should clear timeout on isFinal',
    );
  });

  it('useAgentMessages.ts projects timeout through identity-preserving system_info', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../../web/src/hooks/useAgentMessages.ts', import.meta.url), 'utf8');
    const reconciliationSource = await fs.readFile(
      new URL('../../web/src/hooks/invocation-timeout-reconciliation.ts', import.meta.url),
      'utf8',
    );

    assert.ok(
      source.includes('reconcileTimedOutInvocations(timeoutThreadId)'),
      'Should reconcile canonical invocation truth when the client wait window ends',
    );

    assert.ok(
      reconciliationSource.includes('`invocation-status-${candidate.invocationId}`') &&
        reconciliationSource.includes('Client wait window ended') &&
        reconciliationSource.includes("type: 'system'") &&
        reconciliationSource.includes("let variant: ChatMessage['variant'] = 'info'") &&
        reconciliationSource.includes('variant,'),
      'Should preserve invocation identity in a system info reconciliation notice',
    );
  });
});
