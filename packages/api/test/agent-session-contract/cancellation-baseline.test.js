import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { routeSerial } from '../../dist/domains/cats/services/agents/routing/route-serial.js';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { buildCancelMessages, SocketManager } from '../../dist/infrastructure/websocket/SocketManager.js';
import { ThreadSequencer } from '../../dist/infrastructure/websocket/ThreadSequencer.js';
import { appendTestLifecycleResponseSource } from '../helpers/message-from-fixtures.js';

// Diagnostic regression: the pre-existing cancel route emits transport cleanup
// before routing emits its terminal, even without the bridge. QueueProcessor
// stamps the routing terminal later; this test stops at the socket emit boundary.
for (const bridged of [false, true]) {
  test(
    `cancel broadcast provenance with real ACP child: ${bridged ? 'bridge' : 'built-in'}`,
    { timeout: 15000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'cancel-acp-baseline-'));
      const pools = new Map();
      const previousMode = process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
      // This real-child fixture tests cancellation, not trust in the machine's
      // shared Temp ancestors. Native bootstrap still verifies the private directory itself.
      if (process.platform === 'win32') process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
      try {
        const native = await createAcpServiceForConfig({
          projectRoot: root,
          bootstrapRoot: join(root, 'bootstrap'),
          profileId: 'codex',
          config: {
            id: 'codex',
            clientId: 'acp',
            defaultModel: '',
            mcpSupport: false,
            configurationSource: 'native_tool',
          },
          effectiveModel: '',
          acpConfig: {
            command: 'node',
            startupArgs: [
              fileURLToPath(new URL('../fixtures/agent-session-reference/fake-acp-agent.mjs', import.meta.url)),
            ],
          },
          poolRegistry: pools,
          log: { info() {}, warn() {} },
        });
        assert.ok(native);
        const service = bridged
          ? new AgentSessionBridgeService({
              catId: 'codex',
              provider: new AcpSessionProvider({ catId: 'codex', service: native }),
              passHostOptions: true,
              resolveHostSession: () => ({ sessionId: 'host' }),
            })
          : native;
        const tracker = new InvocationTracker();
        const threadId = `cancel-acp-${bridged}`;
        const batch = tracker.startAll(threadId, ['codex'], 'user1');
        const store = new MessageStore();
        const emitted = [];
        const socket = Object.create(SocketManager.prototype);
        socket.sequencer = new ThreadSequencer();
        socket.rateMonitor = { record() {} };
        socket.io = { to: (room) => ({ emit: (event, message) => emitted.push({ room, event, message }) }) };
        const deps = {
          services: { codex: service },
          invocationDeps: {
            registry: {
              create: () => ({ invocationId: 'child-turn', callbackToken: 'fixture-token' }),
              verify: () => ({ ok: false }),
            },
            sessionManager: {
              get: async () => null,
              getOrCreate: async () => ({}),
              resolveWorkingDirectory: () => root,
            },
            threadStore: {
              get: async () => null,
              getParticipantsWithActivity: async () => [],
              consumeMentionRoutingFeedback: async () => null,
              updateParticipantActivity: async () => {},
            },
            apiUrl: 'http://127.0.0.1:3162',
          },
          messageStore: store,
          draftStore: { delete: async () => {}, touch: async () => {}, upsert: async () => {} },
          toolEventLog: { append: async () => {}, updateSummary: async () => {} },
          socketManager: { broadcastToRoom() {} },
        };
        let stopped = false;
        let responseMessageId;
        for await (const message of routeSerial(deps, ['codex'], '#wait', 'user1', threadId, {
          signal: batch.signal,
          signalForCat: (catId) => tracker.getController(threadId, catId)?.signal,
          onLifecycleInvocationStarted: async (input) => {
            const row = await appendTestLifecycleResponseSource(store, { ...input, timestamp: input.startedAt });
            responseMessageId = row.id;
            return {
              responseMessageId: row.id,
              priorFrontierMessageId: null,
              activeRun: {
                threadId,
                targetId: input.catId,
                invocationId: input.invocationId,
                responseMessageId: row.id,
                inputEntryIds: [],
                inputMessageIds: [],
                privateInputEntryIds: [],
                startedAt: input.startedAt,
              },
            };
          },
        })) {
          socket.broadcastAgentMessage(message, threadId);
          if (message.type === 'text' && message.content === 'waiting' && !stopped) {
            stopped = true;
            const result = tracker.cancel(threadId, 'codex', 'user1', 'user_cancel');
            for (const cleanup of buildCancelMessages({ ...result, catIds: ['codex'] }))
              socket.broadcastAgentMessage(cleanup, threadId);
          }
        }
        assert.equal(stopped, true);
        const done = emitted.filter(({ event, message }) => event === 'agent_message' && message.type === 'done');
        assert.equal(done.length, 2, 'existing transport cleanup and durable routing terminal both broadcast');
        assert.equal(done[0].message.invocationId, undefined);
        assert.equal(done[0].message.messageId, undefined);
        assert.equal(store.getById(responseMessageId).lifecycle.status, 'canceled');
        assert.equal(store.getById(responseMessageId).lifecycle.invocationId, 'child-turn');
        assert.ok(done[0].message.seq < done[1].message.seq);
      } finally {
        try {
          await Promise.all([...pools.values()].map((pool) => pool.closeAll()));
        } finally {
          if (previousMode === undefined) delete process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
          else process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = previousMode;
          await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      }
    },
  );
}
