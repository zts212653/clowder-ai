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

  // F183 Phase E AC-E1 — strict mode escalates warn → throw so dev/CI catches
  // dormant violations instead of silently logging them. Default OFF (warn-only)
  // so production users don't crash on observability-only signals.
  describe('AC-E1 strict mode (BUBBLE_INVARIANT_STRICT)', () => {
    it('default (env unset) does NOT throw — warn-only behavior preserved', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(() => recordBubbleInvariantViolation(violation, 'warn')).not.toThrow();
    });

    it('BUBBLE_INVARIANT_STRICT=1 escalates warn level to throw', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '1');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(() => recordBubbleInvariantViolation(violation, 'warn')).toThrow(/bubble invariant violation/);
    });

    it('BUBBLE_INVARIANT_STRICT=1 escalates error level to throw too', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '1');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(() => recordBubbleInvariantViolation(violation, 'error')).toThrow(/bubble invariant violation/);
    });

    it('BUBBLE_INVARIANT_STRICT=0 (explicit off) does NOT throw', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '0');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(() => recordBubbleInvariantViolation(violation, 'warn')).not.toThrow();
    });

    it('throw still records the debug event before throwing (observability not lost)', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '1');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      configureDebug({ enabled: true });
      expect(() => recordBubbleInvariantViolation(violation, 'warn')).toThrow();
      expect(dumpBubbleTimeline({ rawThreadId: true }).events).toHaveLength(1);
      expect(dumpBubbleTimeline({ rawThreadId: true }).events[0]).toMatchObject({
        event: 'bubble_invariant_violation',
        violationKind: 'duplicate',
      });
    });

    // 砚砚 R1 P1 fix — strict mode must work in browser bundles, not only
    // Node tests. NEXT_PUBLIC_* env is bundled by Next.js into the client.
    it('砚砚 R1 P1: NEXT_PUBLIC_BUBBLE_INVARIANT_STRICT=1 also escalates to throw', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '');
      vi.stubEnv('NEXT_PUBLIC_BUBBLE_INVARIANT_STRICT', '1');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(() => recordBubbleInvariantViolation(violation, 'warn')).toThrow(/bubble invariant violation/);
    });

    // 砚砚 R1 P1 fix — runtime browser toggle: alpha operators can flip
    // strict mode via DevTools `localStorage.setItem(...)` without rebuild.
    it('砚砚 R1 P1: localStorage[catcafe.bubbleInvariantStrict]=1 escalates to throw', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '');
      vi.stubEnv('NEXT_PUBLIC_BUBBLE_INVARIANT_STRICT', '');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // jsdom provides localStorage; happy-dom would too
      try {
        globalThis.localStorage.setItem('catcafe.bubbleInvariantStrict', '1');
        expect(() => recordBubbleInvariantViolation(violation, 'warn')).toThrow(/bubble invariant violation/);
      } finally {
        globalThis.localStorage.removeItem('catcafe.bubbleInvariantStrict');
      }
    });

    it('砚砚 R1 P1: localStorage.getItem errors do NOT crash the diagnostic call', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '');
      vi.stubEnv('NEXT_PUBLIC_BUBBLE_INVARIANT_STRICT', '');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const origGetItem = globalThis.localStorage.getItem;
      // Simulate iframe / privacy-mode error path
      globalThis.localStorage.getItem = () => {
        throw new Error('SecurityError: localStorage blocked');
      };
      try {
        // Should NOT throw the SecurityError nor escalate (env is also off)
        expect(() => recordBubbleInvariantViolation(violation, 'warn')).not.toThrow();
      } finally {
        globalThis.localStorage.getItem = origGetItem;
      }
    });

    // Cloud R1 P1 — even property-level access of `globalThis.localStorage`
    // can throw SecurityError in storage-restricted iframe contexts (third-
    // party context with cookies blocked, file:// origin, sandboxed iframe).
    // The whole access path must be inside try/catch, not just the getItem.
    it('cloud R1 P1: localStorage property access throw does NOT crash diagnostics', () => {
      vi.stubEnv('BUBBLE_INVARIANT_STRICT', '');
      vi.stubEnv('NEXT_PUBLIC_BUBBLE_INVARIANT_STRICT', '');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // Replace the localStorage getter so the property access itself throws,
      // not just the inner getItem call. Mirrors browser SecurityError on
      // property read in storage-restricted contexts.
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
      try {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          get() {
            throw new Error('SecurityError: storage access denied for this context');
          },
        });
        expect(() => recordBubbleInvariantViolation(violation, 'warn')).not.toThrow();
      } finally {
        if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      }
    });
  });
});
