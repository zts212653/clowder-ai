import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { agentSessionMutex } from '../../dist/domains/cats/services/agents/invocation/AgentSessionMutex.js';
import { routeParallel } from '../../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../../dist/domains/cats/services/agents/routing/route-serial.js';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { isolateAccountAuthEnvironment } from '../helpers/account-auth-environment.js';
import { routingJourneyDeps } from '../helpers/routing-journey-deps.js';
import { collect, FakeSessionProvider } from './fake-session-provider.js';

for (const route of [routeSerial, routeParallel]) {
  for (const ending of ['contract-eof', 'acp-eof', 'acp-unconfirmed', 'acp-done']) {
    test(`${route.name} preserves teardown evidence and next-task admission after ${ending}`, async (t) => {
      t.after(isolateAccountAuthEnvironment());
      const all = catRegistry.getAllConfigs();
      const catId = 'eof-teardown';
      const threadId = `owned-${route.name}-${ending}`;
      catRegistry.register(catId, {
        ...all.codex,
        id: catId,
        mcpSupport: false,
        configurationSource: 'native_tool',
        accountRef: undefined,
      });
      t.after(() => {
        catRegistry.reset();
        Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
        agentSessionMutex.forceReleaseByScope({ threadId, userId: 'owner', catId });
      });
      let starts = 0;
      const service = {
        async *invoke() {
          starts++;
          if (ending === 'acp-unconfirmed' || ending === 'acp-done')
            yield {
              type: 'done',
              catId,
              timestamp: 1,
              ...(ending === 'acp-unconfirmed' ? { providerTeardown: 'unconfirmed' } : {}),
            };
        },
      };
      const provider =
        ending === 'contract-eof' ? new FakeSessionProvider() : new AcpSessionProvider({ catId, service });
      if (ending === 'contract-eof') provider.events = [];
      const bridge = new AgentSessionBridgeService({
        catId,
        provider,
        resolveHostSession: () => ({ sessionId: 'host' }),
      });
      const { deps } = routingJourneyDeps(undefined, undefined, bridge);
      deps.services = { [catId]: bridge };
      await collect(route(deps, [catId], 'owned task', 'owner', threadId, { thinkingMode: 'play' }));
      const record = await deps.invocationDeps.turnExecutionStore.get('journey-1');
      assert.ok(record.providerStartedAt !== undefined);
      const confirmed = ending === 'acp-done';
      assert.equal(record.status, confirmed ? 'succeeded' : 'running');
      assert.equal(record.providerTeardownAt !== undefined, confirmed);
      await collect(route(deps, [catId], 'next task', 'owner', threadId, { thinkingMode: 'play' }));
      const next = await deps.invocationDeps.turnExecutionStore.get('journey-2');
      assert.equal(next.status, confirmed ? 'succeeded' : ending === 'contract-eof' ? 'running' : 'failed');
      assert.equal(next.providerStartedAt !== undefined, true);
      assert.equal(
        ending === 'contract-eof' ? provider.bytes.length : starts,
        confirmed || ending === 'contract-eof' ? 2 : 1,
        'the native controller still rejects overlapping ACP turns',
      );
    });
  }
}
