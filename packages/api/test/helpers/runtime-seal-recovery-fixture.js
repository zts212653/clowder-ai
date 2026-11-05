export function runtimeSealMetadata(sessionId = 'seal-budget') {
  return {
    sessionId,
    runtime: 'antigravity-desktop',
    runtimeSessionId: `cascade-${sessionId}`,
    threadId: 'thread-budget',
    catId: 'antig-opus',
    userId: 'test-owner',
    surface: 'cat-cafe-dispatch',
    identityHistory: [{ catId: 'antig-opus', model: 'claude-opus-4-6', from: 1000, source: 'session_init' }],
    lifecycle: { state: 'runtime_seal_pending', startedAt: 1000, lastObservedAt: 2000, retryCount: 5 },
  };
}
