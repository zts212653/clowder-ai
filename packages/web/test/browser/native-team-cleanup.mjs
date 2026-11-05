import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

async function cancelProjection(request, threadId, target) {
  if (target.kind === 'live_invocation') {
    assert.equal(target.threadId, threadId, 'Refuse an inconsistent cross-thread cancellation target');
    return request(
      `/api/threads/${encodeURIComponent(threadId)}/executions/live/${encodeURIComponent(target.executionId)}/cancel`,
      { method: 'POST', body: JSON.stringify({ catId: target.catId }) },
      [409],
    );
  }
  if (target.kind === 'managed_command')
    return request(`/api/callbacks/hold-ball/${encodeURIComponent(target.taskId)}`, { method: 'DELETE' }, [409]);
  throw new Error(`Unknown cancellation target: ${target.kind}`);
}

// Test-owned thread only. A 409 means the execution ended/replaced: refresh the
// projection instead of guessing a PID or canceling another thread's work.
export async function settleOwnedThread(request, threadId, { timeoutMs = 30000, pause = delay, cancel = true } = {}) {
  const canceled = [];
  const deadline = Date.now() + timeoutMs;
  let emptySnapshots = 0;
  while (Date.now() <= deadline) {
    const { executions } = await request('/api/executions/active?projectPath=default');
    const owned = executions.filter((execution) => execution.threadId === threadId);
    if (!owned.length) {
      if (++emptySnapshots >= 3) return canceled;
    } else {
      emptySnapshots = 0;
      for (const execution of owned) {
        if (!cancel || execution.cancelability?.state !== 'cancelable') continue;
        const target = execution.cancelability.target;
        await cancelProjection(request, threadId, target);
        canceled.push({ kind: target.kind, executionId: target.executionId, taskId: target.taskId });
      }
    }
    await pause(750);
  }
  throw new Error(`Test-owned thread ${threadId} did not reach a quiet state within ${timeoutMs}ms`);
}
