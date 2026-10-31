export function trajectoryFixture(url, threadId, requestedInvocations) {
  const trajectory = url.pathname.match(/^\/api\/invocations\/([^/]+)\/trajectory$/);
  const detail = url.pathname.match(/^\/api\/sessions\/session-f295\/invocations\/([^/]+)$/);
  const invocationId = trajectory?.[1] ?? detail?.[1];
  if (!invocationId) return undefined;
  if (trajectory) requestedInvocations.push(invocationId);
  if (!invocationId.startsWith('turn-')) {
    return { status: 404, body: { code: 'INVOCATION_RECORD_NOT_FOUND' } };
  }
  const summary = {
    invocationId,
    threadId,
    sessionId: 'session-f295',
    sessionSeq: 0,
    sessionStatus: 'active',
    catId: invocationId.slice('turn-'.length),
    status: 'running',
    startedAt: 100,
    durationMs: 100,
    eventCount: 0,
    statusEventCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    messageCount: 0,
    errorCount: 0,
    toolNames: [],
    keyMessages: [],
  };
  return {
    status: 200,
    body: trajectory
      ? { invocationId, threadId, sessionId: summary.sessionId }
      : { invocationId, events: [], total: 0, summary },
  };
}
