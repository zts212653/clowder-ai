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
const duringRead = process.argv.includes('--during-read');
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
let reads = 0;
deps.invocationDeps.turnExecutionStore.listRunningByUser = async () => {
  reads++;
  await new Promise((resolve) => setImmediate(resolve));
  if (duringRead) controller.abort(new Error('cancel during the owner read'));
  throw new Error('prior owner read rejected');
};
const acquire = agentSessionMutex.acquire.bind(agentSessionMutex);
agentSessionMutex.acquire = async (holder, signal) => {
  const release = await acquire(holder, signal);
  if (!duringRead && holder.threadId === threadId) controller.abort(new Error('cancel after custody'));
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
  assert.equal(reads, duringRead ? 1 : 0);
  process.stdout.write('prior-read-cancellation-safe\n');
} finally {
  agentSessionMutex.acquire = acquire;
  agentSessionMutex.forceReleaseByScope({ threadId, catId, userId: 'owner' });
  restore();
}
