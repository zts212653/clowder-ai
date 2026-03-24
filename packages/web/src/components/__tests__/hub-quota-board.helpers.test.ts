import { describe, expect, it } from 'vitest';
import {
  classifyQuotaUtilization,
  collectLatestQuotaByCat,
  type QuotaUtilizationLevel,
} from '@/components/hub-quota-board.helpers';
import type { CatInvocationInfo, ThreadState } from '@/stores/chat-types';

function inv(info: Partial<CatInvocationInfo>): CatInvocationInfo {
  return info;
}

function threadState(partial: Partial<ThreadState>): ThreadState {
  return {
    messages: [],
    isLoading: false,
    isLoadingHistory: false,
    hasMore: true,
    hasActiveInvocation: false,
    activeInvocations: {},
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catInvocations: {},
    currentGame: null,
    unreadCount: 0,
    hasUserMention: false,
    lastActivity: 0,
    queue: [],
    queuePaused: false,
    queueFull: false,
    ...partial,
  };
}

describe('hub-quota-board.helpers', () => {
  it('collects latest snapshot by timestamp across active and background threads', () => {
    const result = collectLatestQuotaByCat({
      currentThreadId: 'thread-active',
      activeCatInvocations: {
        codex: inv({
          usage: { inputTokens: 100, outputTokens: 40 },
          contextHealth: {
            usedTokens: 100,
            windowTokens: 1000,
            fillRatio: 0.1,
            source: 'exact',
            measuredAt: 1_000,
          },
        }),
      },
      threadStates: {
        'thread-old': threadState({
          lastActivity: 900,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 50, outputTokens: 20 },
              contextHealth: {
                usedTokens: 50,
                windowTokens: 1000,
                fillRatio: 0.05,
                source: 'exact',
                measuredAt: 900,
              },
            }),
          },
        }),
        'thread-new': threadState({
          lastActivity: 1_500,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 220, outputTokens: 80 },
              contextHealth: {
                usedTokens: 220,
                windowTokens: 1000,
                fillRatio: 0.22,
                source: 'exact',
                measuredAt: 1_500,
              },
            }),
          },
        }),
      },
    });

    expect(result.codex).toBeDefined();
    expect(result.codex?.threadId).toBe('thread-new');
    expect(result.codex?.updatedAt).toBe(1_500);
    expect(result.codex?.invocation.usage?.inputTokens).toBe(220);
  });

  it('falls back to thread lastActivity when invocation has usage but no timestamps', () => {
    const result = collectLatestQuotaByCat({
      currentThreadId: 'thread-active',
      activeCatInvocations: {},
      threadStates: {
        'thread-a': threadState({
          lastActivity: 2_000,
          catInvocations: {
            opus: inv({ usage: { inputTokens: 10 } }),
          },
        }),
      },
    });

    expect(result.opus).toBeDefined();
    expect(result.opus?.updatedAt).toBe(2_000);
    expect(result.opus?.threadId).toBe('thread-a');
  });

  it('does not let current-thread cache override active invocation snapshot', () => {
    const result = collectLatestQuotaByCat({
      currentThreadId: 'thread-current',
      activeCatInvocations: {
        codex: inv({
          usage: { inputTokens: 999, outputTokens: 100 },
          startedAt: 1_500,
        }),
      },
      threadStates: {
        'thread-current': threadState({
          lastActivity: 7_000,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 111, outputTokens: 10 },
              startedAt: 500,
            }),
          },
        }),
      },
    });

    // Active invocation snapshot should remain source of truth for current thread.
    expect(result.codex).toBeDefined();
    expect(result.codex?.threadId).toBe('thread-current');
    expect(result.codex?.invocation.usage?.inputTokens).toBe(999);
    expect(result.codex?.updatedAt).toBe(7_000);
  });

  it('does not elevate updatedAt by thread lastActivity when measuredAt exists', () => {
    const result = collectLatestQuotaByCat({
      currentThreadId: 'thread-active',
      activeCatInvocations: {},
      threadStates: {
        'thread-older-telemetry-but-active': threadState({
          lastActivity: 4_000,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 111, outputTokens: 22 },
              contextHealth: {
                usedTokens: 111,
                windowTokens: 1000,
                fillRatio: 0.111,
                source: 'exact',
                measuredAt: 1_000,
              },
            }),
          },
        }),
        'thread-newer-telemetry': threadState({
          lastActivity: 2_000,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 222, outputTokens: 44 },
              contextHealth: {
                usedTokens: 222,
                windowTokens: 1000,
                fillRatio: 0.222,
                source: 'exact',
                measuredAt: 1_500,
              },
            }),
          },
        }),
      },
    });

    expect(result.codex).toBeDefined();
    // Should pick the newer telemetry (measuredAt=1500), not the thread with newer lastActivity.
    expect(result.codex?.threadId).toBe('thread-newer-telemetry');
    expect(result.codex?.updatedAt).toBe(1_500);
    expect(result.codex?.invocation.usage?.inputTokens).toBe(222);
  });

  it('does not use taskProgress timestamps for quota recency ranking', () => {
    const result = collectLatestQuotaByCat({
      currentThreadId: 'thread-active',
      activeCatInvocations: {},
      threadStates: {
        'thread-a-stale-telemetry': threadState({
          lastActivity: 4_000,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 111, outputTokens: 22 },
              contextHealth: {
                usedTokens: 111,
                windowTokens: 1000,
                fillRatio: 0.111,
                source: 'exact',
                measuredAt: 1_000,
              },
              taskProgress: {
                tasks: [{ id: 't1', subject: 'non-quota task', status: 'in_progress' }],
                lastUpdate: 5_000,
              },
            }),
          },
        }),
        'thread-b-fresh-telemetry': threadState({
          lastActivity: 2_000,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 222, outputTokens: 44 },
              contextHealth: {
                usedTokens: 222,
                windowTokens: 1000,
                fillRatio: 0.222,
                source: 'exact',
                measuredAt: 3_000,
              },
            }),
          },
        }),
      },
    });

    // should pick fresh quota telemetry (measuredAt=3000), not task progress update time
    expect(result.codex).toBeDefined();
    expect(result.codex?.threadId).toBe('thread-b-fresh-telemetry');
    expect(result.codex?.updatedAt).toBe(3_000);
    expect(result.codex?.invocation.usage?.inputTokens).toBe(222);
  });

  it('does not use startedAt to outrank fresher telemetry snapshots', () => {
    const result = collectLatestQuotaByCat({
      currentThreadId: 'thread-active',
      activeCatInvocations: {},
      threadStates: {
        'thread-a-session-restarted': threadState({
          lastActivity: 1_000,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 111, outputTokens: 22 },
              startedAt: 5_000,
            }),
          },
        }),
        'thread-b-fresh-telemetry': threadState({
          lastActivity: 2_000,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 222, outputTokens: 44 },
              contextHealth: {
                usedTokens: 222,
                windowTokens: 1000,
                fillRatio: 0.222,
                source: 'exact',
                measuredAt: 3_000,
              },
            }),
          },
        }),
      },
    });

    // A restart timestamp is not quota telemetry and must not beat measuredAt=3000.
    expect(result.codex).toBeDefined();
    expect(result.codex?.threadId).toBe('thread-b-fresh-telemetry');
    expect(result.codex?.updatedAt).toBe(3_000);
    expect(result.codex?.invocation.usage?.inputTokens).toBe(222);
  });

  it('uses current-thread lastActivity fallback for active snapshots without measuredAt', () => {
    const result = collectLatestQuotaByCat({
      currentThreadId: 'thread-active',
      activeCatInvocations: {
        codex: inv({
          usage: { inputTokens: 999, outputTokens: 90 },
        }),
      },
      threadStates: {
        'thread-active': threadState({
          lastActivity: 8_000,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 100, outputTokens: 10 },
            }),
          },
        }),
        'thread-background-stale': threadState({
          lastActivity: 6_000,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 111, outputTokens: 11 },
            }),
          },
        }),
      },
    });

    // Active snapshot should use current thread activity fallback instead of defaulting to 0.
    expect(result.codex).toBeDefined();
    expect(result.codex?.threadId).toBe('thread-active');
    expect(result.codex?.updatedAt).toBe(8_000);
    expect(result.codex?.invocation.usage?.inputTokens).toBe(999);
  });

  it('prefers active snapshot when both active and background entries lack telemetry timestamps', () => {
    const result = collectLatestQuotaByCat({
      currentThreadId: 'thread-active',
      activeCatInvocations: {
        codex: inv({
          usage: { inputTokens: 999, outputTokens: 90 },
        }),
      },
      threadStates: {
        'thread-background': threadState({
          lastActivity: 6_000,
          catInvocations: {
            codex: inv({
              usage: { inputTokens: 111, outputTokens: 11 },
            }),
          },
        }),
      },
    });

    // Without measuredAt on both sides, active snapshot should remain preferred.
    expect(result.codex).toBeDefined();
    expect(result.codex?.threadId).toBe('thread-active');
    expect(result.codex?.invocation.usage?.inputTokens).toBe(999);
  });

  it('ignores invocation entries without quota-related telemetry', () => {
    const result = collectLatestQuotaByCat({
      currentThreadId: 'thread-active',
      activeCatInvocations: {
        gemini: inv({ startedAt: 100 }),
      },
      threadStates: {},
    });

    expect(result.gemini).toBeUndefined();
  });

  it('classifies utilization thresholds for warning levels', () => {
    const cases: Array<{ v: number; expected: QuotaUtilizationLevel }> = [
      { v: 0.7, expected: 'ok' },
      { v: 0.8, expected: 'warn' },
      { v: 0.9, expected: 'high' },
      { v: 0.95, expected: 'critical' },
    ];

    for (const c of cases) {
      expect(classifyQuotaUtilization(c.v)).toBe(c.expected);
    }
  });
});
