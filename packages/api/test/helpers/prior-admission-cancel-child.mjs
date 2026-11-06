import './setup-cat-registry.js';
import assert from 'node:assert/strict';
import { catRegistry } from '@cat-cafe/shared';
import { agentSessionMutex } from '../../dist/domains/cats/services/agents/invocation/AgentSessionMutex.js';
import { routeSerial } from '../../dist/domains/cats/services/agents/routing/route-serial.js';
import { isolateAccountAuthEnvironment } from './account-auth-environment.js';
import { routingJourneyDeps } from './routing-journey-deps.js';

const restore = isolateAccountAuthEnvironment();
const catId = 'prior-read-cancel';
const threadId = 'prior-read-cancel-thread';
const whileWaiting = process.argv.includes('--while-waiting');
catRegistry.register(catId, {
  ...catRegistry.getAllConfigs().codex,
  id: catId,
  mcpSupport: false,
  configurationSource: 'native_tool',
  accountRef: undefined,
});
const controller = new AbortController();
let calls = 0;
const service = {
  async *invoke() {
    calls++;
    throw new Error('provider must not be called');
  },
};
const { deps } = routingJourneyDeps(undefined, undefined, service);
deps.services = { [catId]: service };
deps.invocationDeps.sessionManager.get = async () => 'owned-runtime';
const originalAcquire = agentSessionMutex.acquire;
const acquire = originalAcquire.bind(agentSessionMutex);
let acquisitions = 0;
let releaseBlocker;
agentSessionMutex.acquire = async (holder, signal) => {
  if (holder.threadId !== threadId) return acquire(holder, signal);
  acquisitions++;
  if (whileWaiting) {
    releaseBlocker = await acquire({ ...holder, invocationId: 'existing-holder', executionId: 'existing-parent' });
    const waiting = acquire(holder, signal);
    setImmediate(() => controller.abort(new Error('cancel while waiting for actual session custody')));
    return waiting;
  }
  const release = await acquire(holder, signal);
  controller.abort(new Error('cancel after actual session custody'));
  return release;
};
try {
  await Array.fromAsync(
    routeSerial(deps, [catId], 'do not send', 'owner', threadId, {
      thinkingMode: 'play',
      signal: controller.signal,
    }),
  );
  // Allow a detached rejection to reach Node's real strict unhandled-rejection boundary.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(acquisitions, 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal((await deps.invocationDeps.turnExecutionStore.get('journey-1')).status, 'canceled');
  process.stdout.write('session-custody-cancellation-safe\n');
} finally {
  agentSessionMutex.acquire = originalAcquire;
  releaseBlocker?.();
  agentSessionMutex.forceReleaseByScope({ threadId, catId, userId: 'owner' });
  restore();
}
