import type { BubbleInvariantViolation } from '@cat-cafe/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordBubbleInvariantViolation } from '../bubbleInvariantDiagnostics';
import { clearDebugEvents, configureDebug, dumpBubbleTimeline } from '../invocationEventDebug';

const violation: BubbleInvariantViolation = {
  threadId: 'thread-raw',
  actorId: 'codex',
  canonicalInvocationId: 'inv-1',
  bubbleKind: 'assistant_text',
  eventType: 'callback_final',
  originPhase: 'callback/history',
  sourcePath: 'callback',
  existingMessageId: 'msg-stream',
  incomingMessageId: 'msg-callback',
  seq: 42,
  recoveryAction: 'quarantine',
  violationKind: 'duplicate',
  timestamp: 1234,
};

describe('F183 bubble invariant diagnostics', () => {
  beforeEach(() => {
    clearDebugEvents();
    configureDebug({ enabled: false });
  });

  afterEach(() => {
    clearDebugEvents();
    configureDebug({ enabled: false });
    vi.restoreAllMocks();
  });

  it('records ADR-033 13-field violation payload at warn level', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureDebug({ enabled: true });

    recordBubbleInvariantViolation(violation, 'warn');

    expect(warn).toHaveBeenCalledWith('[F183] bubble invariant violation', expect.objectContaining(violation));
    expect(dumpBubbleTimeline({ rawThreadId: true }).events).toEqual([
      expect.objectContaining({
        event: 'bubble_invariant_violation',
        level: 'warn',
        threadId: 'thread-raw',
        actorId: 'codex',
        canonicalInvocationId: 'inv-1',
        bubbleKind: 'assistant_text',
        eventType: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        existingMessageId: 'msg-stream',
        incomingMessageId: 'msg-callback',
        seq: 42,
        recoveryAction: 'quarantine',
        violationKind: 'duplicate',
        timestamp: 1234,
      }),
    ]);
  });

  it('records error level for non-recoverable violations', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configureDebug({ enabled: true });

    recordBubbleInvariantViolation({ ...violation, violationKind: 'phase-regression' }, 'error');

    expect(error).toHaveBeenCalledWith(
      '[F183] bubble invariant violation',
      expect.objectContaining({ violationKind: 'phase-regression' }),
    );
    expect(dumpBubbleTimeline({ rawThreadId: true }).events[0]).toMatchObject({
      event: 'bubble_invariant_violation',
      level: 'error',
      violationKind: 'phase-regression',
    });
  });
});
