import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { agentSessionMutex } from '../../dist/domains/cats/services/agents/invocation/AgentSessionMutex.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { routeParallel } from '../../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../../dist/domains/cats/services/agents/routing/route-serial.js';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { buildCancelMessages, SocketManager } from '../../dist/infrastructure/websocket/SocketManager.js';
import { ThreadSequencer } from '../../dist/infrastructure/websocket/ThreadSequencer.js';
import { appendTestLifecycleResponseSource } from '../helpers/message-from-fixtures.js';
import { deferred } from './fake-session-provider.js';

// A socket cancellation is a request. The route owns the one terminal after
// execution cleanup; the transport cannot publish an earlier synthetic done.
for (const { route, mixed } of [
  { route: routeSerial, mixed: false },
  { route: routeParallel, mixed: false },
])
  for (const bridged of [false, true]) {
    test(
      `physical stop before ${route.name} terminal: ${bridged ? 'bridge' : 'built-in'}; mixed=${mixed}`,
      { timeout: 15000 },
      async (t) => {
        const all = catRegistry.getAllConfigs();
        const config = {
          ...all.codex,
          id: 'codex',
          clientId: 'acp',
          defaultModel: '',
          mcpSupport: false,
          configurationSource: 'native_tool',
          accountRef: undefined,
          cli: { effort: '' },
        };
        catRegistry.reset();
        Object.entries(all).forEach(([id, member]) => {
          catRegistry.register(id, id === 'codex' ? config : member);
        });
        t.after(() => {
          catRegistry.reset();
          Object.entries(all).forEach(([id, member]) => {
            catRegistry.register(id, member);
          });
        });
        const parent = resolve('artifacts/role-agent-refactor/native-unconfirmed-lifecycle');
        await mkdir(parent, { recursive: true });
        const root = await mkdtemp(join(parent, 'owned native state '));
        const closing = deferred(),
          stop = deferred();
        const fixture = fileURLToPath(new URL('../fixtures/codeagent-mock.mjs', import.meta.url));
        let client, run, cleanupClient;
        const instance = {
          task: 'role-agent-refactor-20261029-gpt-sol',
          owner: 'codex',
          mock: true,
          sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          runtimeModules: await Promise.all(
            [
              'invocation/invoke-single-cat.js',
              'providers/acp/AcpAgentService.js',
              'routing/route-serial.js',
              'routing/route-parallel.js',
              'session-contract/AgentSessionBridgeService.js',
            ].map(async (name) => ({
              name,
              sha256: createHash('sha256')
                .update(
                  await readFile(
                    fileURLToPath(new URL(`../../dist/domains/cats/services/agents/${name}`, import.meta.url)),
                  ),
                )
                .digest('hex'),
            })),
          ),
          program: process.execPath,
          fixture,
          fixtureSha256: createHash('sha256')
            .update(await readFile(fixture))
            .digest('hex'),
          nativeHome: root,
          dataDirectory: root,
          ports: [],
          networkUsed: false,
          nativeCredentialsUsed: false,
          startedAt: new Date().toISOString(),
        };
        const pools = new Map();
        const previousMode = process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
        // This fixture verifies cancel delivery, not trust in the machine's Temp ancestors.
        // Strict-mode rejection remains covered by the native bootstrap security tests.
        if (process.platform === 'win32') process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
        try {
          const native = await createAcpServiceForConfig({
            projectRoot: root,
            bootstrapRoot: join(root, 'bootstrap'),
            profileId: 'codex',
            config,
            effectiveModel: '',
            acpConfig: {
              command: process.execPath,
              startupArgs: [fixture, '--state-dir', root],
            },
            poolRegistry: pools,
            log: { info() {}, warn() {} },
          });
          assert.ok(native);
          const pool = pools.get('codex'),
            createClient = pool.clientFactory;
          pool.clientFactory = (...args) => {
            client = createClient(...args);
            // Cancellation witness only: isolate mock native state at the existing client test seam.
            client.config.env = { HOME: root, USERPROFILE: root };
            client.config.inheritParentEnv = false;
            const close = client.close.bind(client);
            cleanupClient = close;
            client.close = async () => {
              closing.resolve();
              await stop.promise;
              throw new Error('owned route retirement failure');
            };
            return client;
          };
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
          const targets = mixed ? ['codex', 'kimi'] : ['codex'];
          const batch = tracker.startAll(threadId, targets, 'user1');
          const store = new MessageStore();
          const emitted = [];
          const socket = Object.create(SocketManager.prototype);
          socket.sequencer = new ThreadSequencer();
          socket.rateMonitor = { record() {} };
          socket.io = { to: (room) => ({ emit: (event, message) => emitted.push({ room, event, message }) }) };
          let invocationSeq = 0;
          const turns = new InMemoryTurnExecutionStore();
          const deps = {
            services: {
              codex: service,
              ...(mixed
                ? {
                    kimi: {
                      async *invoke(_prompt, options) {
                        assert.equal(options.signal.aborted, false, 'a healthy sibling retains its own signal');
                        yield { type: 'text', catId: 'kimi', content: 'healthy sibling', timestamp: Date.now() };
                        yield { type: 'done', catId: 'kimi', timestamp: Date.now() };
                      },
                    },
                  }
                : {}),
            },
            invocationDeps: {
              turnExecutionStore: turns,
              registry: {
                create: () => ({ invocationId: `child-turn-${++invocationSeq}`, callbackToken: 'fixture-token' }),
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
          const errors = [];
          let responseMessageId;
          let responseInvocationId;
          run = (async () => {
            for await (const message of route(deps, targets, '#wait', 'user1', threadId, {
              signal: batch.signal,
              signalForCat: (catId) => tracker.getController(threadId, catId)?.signal,
              onLifecycleInvocationStarted: async (input) => {
                const row = await appendTestLifecycleResponseSource(store, { ...input, timestamp: input.startedAt });
                if (input.catId === 'codex') {
                  responseMessageId = row.id;
                  responseInvocationId = input.invocationId;
                }
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
              if (message.type === 'error') errors.push({ code: message.errorCode, error: message.error });
              if (message.type === 'text' && message.content === 'waiting' && !stopped) {
                stopped = true;
                const result = tracker.cancel(threadId, 'codex', 'user1', 'user_cancel');
                for (const cleanup of buildCancelMessages({ ...result, catIds: ['codex'] }))
                  socket.broadcastAgentMessage(cleanup, threadId);
              }
            }
          })();
          await closing.promise;
          await writeFile(
            join(root, 'instance.json'),
            JSON.stringify({ ...instance, pid: client.pid, status: 'running' }, null, 2),
          );
          // Exceed the Host's existing one-second abandoned-iterator timeout.
          await new Promise((resolve) => setTimeout(resolve, 1250));
          assert.equal(client.isAlive, true);
          assert.equal(
            emitted.some(({ message }) => message.type === 'done' && message.catId === 'codex'),
            false,
            'a live retiring native process cannot be projected as terminal',
          );
          if (mixed)
            assert.equal(
              emitted.some(({ message }) => message.type === 'done' && message.catId === 'kimi'),
              true,
              'a healthy legacy sibling completes while the ACP child is stopping',
            );
          stop.resolve();
          await run;
          assert.equal(stopped, true, JSON.stringify(errors));
          const done = emitted.filter(
            ({ event, message }) => event === 'agent_message' && message.type === 'done' && message.catId === 'codex',
          );
          const requests = emitted.filter(
            ({ message }) => message.type === 'status' && /等待执行状态确认/.test(message.content),
          );
          assert.equal(requests.length, 1);
          assert.notEqual(requests[0].message.isFinal, true);
          await writeFile(
            join(root, 'wire-evidence.json'),
            JSON.stringify(
              {
                done,
                storedStatus: store.getById(responseMessageId)?.lifecycle.status,
                nativeAlive: client.isAlive,
                execution: turns.get(responseInvocationId),
                activeChildren: turns.listRunningByUser('user1'),
              },
              null,
              2,
            ),
          );
          assert.equal(done.length, 0, 'unconfirmed physical stop must retain stopping rather than publish a terminal');
          assert.equal(store.getById(responseMessageId).lifecycle.status, 'processing');
          assert.equal(turns.get(responseInvocationId).status, 'running');
          assert.equal(turns.get(responseInvocationId).providerTeardownAt, undefined);
          assert.equal(turns.listRunningByUser('user1').length, 1);
          assert.equal(
            emitted.some(({ message }) => message.type === 'status' && message.providerTeardown === 'unconfirmed'),
            true,
          );
          const blockedTask = 'owned-unknown-stop-do-not-send-6c8e1';
          const blocked = await Array.fromAsync(
            service.invoke(blockedTask, { invocationId: 'blocked', workingDirectory: root }),
          );
          if (bridged) assert.equal(blocked[0].errorCode, 'busy');
          else
            assert.equal(
              blocked.some((event) => event.type === 'error'),
              true,
            );
          assert.equal(
            pools.get('codex').getMetrics().coldStartCount,
            1,
            'unknown stop must not create another carrier',
          );
          assert.equal(store.getById(responseMessageId).lifecycle.invocationId, responseInvocationId);
          const sessionFiles = (await readdir(root)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
          assert.equal(sessionFiles.length, 1);
          const history = JSON.parse(await readFile(join(root, sessionFiles[0]), 'utf8'));
          assert.equal(
            history.some((text) => text.includes(blockedTask)),
            false,
            'unknown stop must not deliver the next task',
          );
          assert.notEqual(requests[0].message.isFinal, true);
          assert.equal(pools.get('codex').getMetrics().activeLeaseCount, 0);
        } finally {
          stop.resolve();
          await run.catch(() => {});
          await assert.rejects(
            Promise.all([...pools.values()].map((pool) => pool.closeAll())),
            /owned route retirement failure/,
          );
          await cleanupClient();
          agentSessionMutex.forceReleaseByScope({ threadId: `cancel-acp-${bridged}`, userId: 'user1', catId: 'codex' });
          await writeFile(
            join(root, 'instance.json'),
            JSON.stringify(
              {
                ...instance,
                pid: client?.pid,
                status: 'closed-data-retained',
                running: client?.isAlive ?? false,
                stoppedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
          if (previousMode === undefined) delete process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
          else process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = previousMode;
          assert.equal(client?.isAlive ?? false, false);
        }
      },
    );
  }
