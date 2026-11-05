import { resolveCodexAccountLaunch } from '../../src/config/codex-account-launch.js';
import { CodexAgentService } from '../../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { routeParallel } from '../../src/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../../src/domains/cats/services/agents/routing/route-serial.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { CodexStartupWire } from './codex-startup-wire.js';
import { fakeL0Compiler } from './fake-l0-compiler.js';

/** Real invocation → service → Runner → route writer; only the native protocol peer is fake. */
export function createCodexStartupRouteHarness({
  root,
  threadId = 'startup-chat',
  userId = 'fixture',
  catId = 'codex',
  retryDelaysMs = [0, 0, 0, 0, 0],
  onEvent = () => {},
  onResponse = () => {},
}) {
  const store = new MessageStore();
  let sequence = 0;
  const runs = [];
  return {
    store,
    runs,
    start({ scenario = 'recover', origin = 'user', mode = 'serial', content } = {}) {
      const source = store.append({
        from: origin === 'user' ? { kind: 'user', userId } : { kind: 'system', service: 'hold_ball' },
        userId,
        threadId,
        content: content ?? (origin === 'user' ? 'Please finish the original task.' : 'Resume the original held task.'),
        mentions: [],
        timestamp: Date.now(),
      });
      const controller = new AbortController();
      const run = {
        source,
        controller,
        wires: [],
        events: [],
        responseId: undefined,
        pending: undefined,
        launchSnapshots: [],
      };
      runs.push(run);
      const descriptor = resolveCodexAccountLaunch(
        { id: 'codex', authType: 'oauth', envVars: { CODEX_HOME: root } },
        { cwd: root },
      );
      const realService = new CodexAgentService({
        catId,
        carrierMode: 'app_server',
        cliCommand: process.execPath,
        l0CompilerFn: fakeL0Compiler,
        appServerStartupRecovery: {
          retryDelaysMs,
          budgetMs: Math.max(10_000, retryDelaysMs.reduce((a, b) => a + b, 0) + 5_000),
        },
        rawArchive: { append: async () => {} },
      });
      const service = {
        async *invoke(prompt, options) {
          yield* realService.invoke(prompt, {
            ...options,
            codexAccountLaunch: descriptor,
            workingDirectory: root,
            agentCarrierSessionFactory: async (launch) => {
              run.launchSnapshots.push(launch);
              const fail = scenario !== 'recover' || run.wires.length < 2;
              const wire = new CodexStartupWire(
                fail ? { code: -32603, message: 'workspace routing discovery timed out' } : undefined,
                { model_provider: 'openai', sqlite_home: descriptor.sqliteHome },
              );
              run.wires.push(wire);
              return wire;
            },
          });
        },
      };
      const deps = {
        services: { [catId]: service },
        messageStore: store,
        invocationDeps: {
          registry: {
            create: () => ({ invocationId: `startup-${++sequence}`, callbackToken: 'fixture' }),
            verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
          },
          sessionManager: { get: async () => null, getOrCreate: async () => ({}), resolveWorkingDirectory: () => root },
          threadStore: {
            get: async () => null,
            getParticipantsWithActivity: async () => [],
            consumeMentionRoutingFeedback: async () => null,
            updateParticipantActivity: async () => {},
          },
          apiUrl: 'http://127.0.0.1:0',
        },
      };
      const route = mode === 'serial' ? routeSerial : routeParallel;
      run.pending = (async () => {
        for await (const event of route(deps, [catId], source.content, userId, threadId, {
          currentUserMessageId: source.id,
          humanDispositionInvocationOrigin: origin === 'user' ? 'direct_owner' : 'system',
          signal: controller.signal,
          onLifecycleInvocationStarted: async ({ invocationId, startedAt }) => {
            const response = store.append({
              from: { kind: 'agent', catId },
              userId,
              threadId,
              content: '',
              mentions: [],
              timestamp: startedAt,
              lifecycle: {
                kind: 'response',
                orderKey: `${startedAt}:${invocationId}`,
                invocationId,
                targetId: catId,
                inputEntryIds: [],
                inputMessageIds: [source.id],
                status: 'processing',
                startedAt,
              },
            });
            run.responseId = response.id;
            onResponse(response);
            return { responseMessageId: response.id, priorFrontierMessageId: null };
          },
        })) {
          run.events.push(event);
          await onEvent(event, run, store);
        }
        const response = await store.getById(run.responseId);
        if (response) onResponse(response);
        return response;
      })();
      return run;
    },
  };
}
