import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { deferred } from '../agent-session-contract/fake-session-provider.js';

for (const registered of [false, true]) {
  for (const capability of [undefined, { protocol: 1, steer: true, nativeTurns: true }]) {
    test(
      `cancellation during bridge probe starts no prompt (${registered ? 'registered' : 'direct'}, capability=${Boolean(capability)})`,
      { timeout: 10000 },
      async () => {
        const entered = deferred();
        const probe = deferred();
        const controller = new AbortController();
        const calls = { prompts: 0, cancelled: 0, sealed: 0, released: 0, subscribed: 0, registered: 0 };
        const client = {
          recentCapacitySignal: null,
          onCapacity() {},
          offCapacity() {},
          clearRecentCapacitySignal() {},
          async newSession() {
            return { sessionId: 'cancel-probe-session', configOptions: [] };
          },
          async probeTurnBridge() {
            entered.resolve();
            return probe.promise;
          },
          onTurnBridgeEvent() {
            calls.subscribed++;
            return () => {};
          },
          cancelSession() {
            calls.cancelled++;
          },
          async *promptStream(sessionId) {
            calls.prompts++;
            yield {
              sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unwanted work' } },
            };
          },
        };
        const host = new AcpAgentService({
          catId: 'dsh',
          providerName: 'dsh',
          modelName: 'fixture',
          projectRoot: process.cwd(),
          dshTurnInput: true,
          mcpSupport: false,
          poolKey: { projectPath: process.cwd(), providerProfile: 'cancel-probe-fixture' },
          pool: {
            async acquire() {
              return {
                client,
                release() {
                  calls.released++;
                },
              };
            },
            sealSession() {
              calls.sealed++;
            },
          },
        });
        let service = host;
        if (registered) {
          const ref = { builtin: 'cancel-probe-fixture' };
          const registry = new SessionImplementationRegistry();
          registry.register(ref, () => new AcpSessionProvider({ catId: 'dsh', service: host }));
          service = new RegisteredSessionAgentService({
            catId: 'dsh',
            ref,
            registry,
            metadata: { provider: 'dsh', model: 'fixture' },
          });
        }
        const messages = [];
        const invocation = (async () => {
          for await (const message of service.invoke('must not start', {
            signal: controller.signal,
            invocationId: 'cancel-probe-invocation',
            hostSessionId: 'cancel-probe-host-session',
            activeRunDispatch: {
              invocationId: 'cancel-probe-invocation',
              register() {
                calls.registered++;
                return () => {};
              },
            },
          }))
            messages.push(message);
        })();
        await entered.promise;
        controller.abort();
        probe.resolve(capability);
        await invocation;
        assert.equal(calls.prompts, 0, 'an aborted probe must not launch model or tool work');
        assert.equal(calls.subscribed, 0, 'an aborted turn must not acquire a bridge input binding');
        assert.equal(calls.registered, 0);
        assert.equal(calls.cancelled, 0, 'a prompt never sent needs no provider cancellation');
        assert.equal(calls.sealed, 0, 'a prompt never sent must not seal the session');
        assert.equal(calls.released, 1);
        assert.equal(
          messages.some((message) => message.type === 'text' || message.type === 'error'),
          false,
        );
        assert.equal(messages.at(-1)?.type, 'done');
      },
    );
  }
}
