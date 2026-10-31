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

  it('QueueProcessor sets up a 30s heartbeat interval for canonical execution', async () => {
    // Read the source to verify the constant
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      new URL('../src/domains/cats/services/agents/invocation/QueueProcessor.ts', import.meta.url),
      'utf8',
    );

    // Verify HEARTBEAT_INTERVAL_MS is defined as 30000
    assert.ok(
      source.includes('HEARTBEAT_INTERVAL_MS = 30_000') || source.includes('HEARTBEAT_INTERVAL_MS = 30000'),
      'HEARTBEAT_INTERVAL_MS should be 30 seconds',
    );

    // Verify broadcastToRoom is called with 'heartbeat' event
    assert.ok(source.includes("'heartbeat'"), 'Should broadcast heartbeat event');
  });

  it('canonical execution clears its heartbeat interval in finally', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      new URL('../src/domains/cats/services/agents/invocation/QueueProcessor.ts', import.meta.url),
      'utf8',
    );

    // Verify clearInterval is called in finally
    assert.ok(source.includes('clearInterval(heartbeatInterval)'), 'Should clear heartbeat interval in finally block');

    // Verify finally block exists
    assert.ok(source.includes('} finally {'), 'Should have finally block');
  });

  it('canonical heartbeat does not keep an abandoned test or shutdown process alive', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      new URL('../src/domains/cats/services/agents/invocation/QueueProcessor.ts', import.meta.url),
      'utf8',
    );

    assert.ok(source.includes('heartbeatInterval.unref()'), 'Heartbeat timer should not own process liveness');
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
  it('socket message projection owns no client deadline for the server execution', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../../web/src/hooks/useAgentMessages.ts', import.meta.url), 'utf8');

    assert.doesNotMatch(source, /DONE_TIMEOUT_MS|setTimeout\(/);
    assert.match(source, /handleActiveAgentMessage\(msg, ctx\)/);
  });

  it('every socket message dispatches to its exact active or background thread', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../../web/src/hooks/useAgentMessages.ts', import.meta.url), 'utf8');

    assert.match(source, /msg.threadId === store.currentThreadId/);
    assert.match(source, /handleBackgroundAgentMessage\(/);
    assert.doesNotMatch(source, /resetTimeout\(/);
  });

  // Loading and terminal behaviour is verified by the web useAgentMessages-loading suite.

  it('timeout diagnostics settle the named result without a second reconciliation notice', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../../web/src/hooks/useAgentMessages.ts', import.meta.url), 'utf8');
    const terminalSource = await fs.readFile(
      new URL('../../web/src/hooks/agent-messages/active-terminal.ts', import.meta.url),
      'utf8',
    );

    assert.doesNotMatch(source, /reconcileTimedOutInvocations|invocation-status-/);
    assert.match(terminalSource, /timeoutDiagnostics.take\(threadId, msg.catId\)/);
    assert.match(terminalSource, /if \(!stale && !target\) upsertUnansweredErrorRow/);
    await assert.rejects(
      fs.access(new URL('../../web/src/hooks/invocation-timeout-reconciliation.ts', import.meta.url)),
      { code: 'ENOENT' },
    );
  });
});
