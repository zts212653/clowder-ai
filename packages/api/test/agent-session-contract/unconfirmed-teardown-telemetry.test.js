import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { agentSessionMutex } from '../../dist/domains/cats/services/agents/invocation/AgentSessionMutex.js';
import { routeSerial } from '../../dist/domains/cats/services/agents/routing/route-serial.js';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { isolateAccountAuthEnvironment } from '../helpers/account-auth-environment.js';
import { routingJourneyDeps } from '../helpers/routing-journey-deps.js';
import { collect } from './fake-session-provider.js';

for (const ending of ['explicit-unconfirmed', 'eof'])
  test(`an ACP ${ending} stays terminal telemetry without inventing provider stop proof or blocking the next dispatch`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const all = catRegistry.getAllConfigs();
    const catId = `unconfirmed-${ending}`;
    const threadId = `owned-${ending}`;
    catRegistry.register(catId, {
      ...all.codex,
      id: catId,
      mcpSupport: false,
      configurationSource: 'native_tool',
      accountRef: undefined,
    });
    t.after(() => {
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => {
        catRegistry.register(id, config);
      });
      agentSessionMutex.forceReleaseByScope({ threadId, userId: 'owner', catId });
    });
    let starts = 0;
    const native = {
      async *invoke() {
        starts += 1;
        if (ending === 'explicit-unconfirmed') {
          yield { type: 'done', catId, timestamp: Date.now(), providerTeardown: 'unconfirmed' };
        }
      },
    };
    const bridge = new AgentSessionBridgeService({
      catId,
      provider: new AcpSessionProvider({ catId, service: native }),
      resolveHostSession: () => ({ sessionId: 'owned-host' }),
    });
    const { deps } = routingJourneyDeps(undefined, undefined, bridge);
    deps.services = { [catId]: bridge };

    const firstMessages = await collect(
      routeSerial(deps, [catId], 'first', 'owner', threadId, { thinkingMode: 'play' }),
    );
    const first = await deps.invocationDeps.turnExecutionStore.get('journey-1');
    assert.equal(
      firstMessages.some((message) => message.providerTeardown === 'unconfirmed'),
      true,
    );
    assert.equal(first.status, ending === 'explicit-unconfirmed' ? 'succeeded' : 'failed');
    assert.ok(first.providerStartedAt !== undefined);
    assert.equal(first.providerTeardownAt, undefined, 'unknown native teardown is not rewritten as stop proof');

    await collect(routeSerial(deps, [catId], 'second', 'owner', threadId, { thinkingMode: 'play' }));
    const second = await deps.invocationDeps.turnExecutionStore.get('journey-2');
    assert.equal(second.status, ending === 'explicit-unconfirmed' ? 'succeeded' : 'failed');
    assert.equal(starts, 2, 'teardown telemetry has no admission authority');
  });
