import './setup-cat-registry.js';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'f325-auth-host-'));
const savedEnv = Object.fromEntries(
  ['HOME', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'AUDIT_LOG_DIR', 'CAT_CAFE_DATA_DIR'].map((key) => [key, process.env[key]]),
);
process.env.HOME = root;
process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
process.env.AUDIT_LOG_DIR = join(root, 'audit');
let invokeSingleCat,
  AgyNativeAgentService,
  SessionChainStore,
  SessionSealer,
  TranscriptWriter,
  ContextEpochOwner,
  InMemoryContextEpochStore,
  resolveInvocationCapacitySnapshot;
before(async () => {
  ({ invokeSingleCat } = await import('../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js'));
  ({ AgyNativeAgentService } = await import(
    '../../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
  ));
  ({ SessionChainStore } = await import('../../dist/domains/cats/services/stores/ports/SessionChainStore.js'));
  ({ SessionSealer } = await import('../../dist/domains/cats/services/session/SessionSealer.js'));
  ({ TranscriptWriter } = await import('../../dist/domains/cats/services/session/TranscriptWriter.js'));
  ({ ContextEpochOwner } = await import('../../dist/domains/cats/services/session/context/ContextEpochOwner.js'));
  ({ InMemoryContextEpochStore } = await import('../../dist/domains/cats/services/stores/ports/ContextEpochStore.js'));
  ({ resolveInvocationCapacitySnapshot } = await import(
    '../../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js'
  ));
});
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

export async function runNativeAuthContinuation(mode = 'confirmed', evidence = {}) {
  const base = mkdtempSync(join(root, 'case-'));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace);
  const effect = join(workspace, 'effect.log');
  const threadId = `auth-${mode}`;
  const chain = new SessionChainStore();
  const writer = new TranscriptWriter({ dataDir: join(base, 'transcripts') });
  const append = writer.appendDurableEvent.bind(writer);
  writer.appendDurableEvent = async (session, event, ...args) => {
    if (
      (mode === 'failure-record-unavailable' && event.type === 'request_generation_terminal') ||
      (mode === 'continuation-record-unavailable' &&
        event.type === 'request_generation_assembled' &&
        event.envelope.generationOrdinal === 2)
    ) {
      throw new Error('fixture_transcript_unavailable');
    }
    return append(session, event, ...args);
  };
  const record = await chain.create({ catId: 'gemini38', threadId, userId: 'owner' });
  const controller = new AbortController();
  let calls = 0,
    factoryCalls = 0,
    runtimeSessionId;
  const launches = [],
    writes = [];
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    profile: {
      enabled: true,
      autoApprove: true,
      profileId: 'gemini38',
      homeRoot: join(base, 'profiles'),
      model: 'gemini-3.8-flash-high',
    },
    l0CompilerFn: async () => `# Identity\nFixture${mode === 'binding-drift' && calls > 1 ? ' changed' : ''}.\n`,
    rawArchive: { append: async () => {} },
  });
  const step = (index, fields) => ({
    event: 'step_update',
    step_update: { conversation_id: 'same-native', step_index: index, state: 'DONE', ...fields },
  });
  const error = () => ({
    __cliError: true,
    exitCode: 3,
    signal: null,
    command: '/usr/bin/true',
    message: 'CLI exit 3',
    reasonCode: 'auth_failed',
    cliDiagnostics: {
      reasonCode: 'auth_failed',
      publicSummary: 'API authentication failed',
      publicHint: 'Check CLI sign-in',
      debugRef: { command: '/usr/bin/true', exitCode: 3, signal: null },
    },
  });
  const actual = service.invokeWithContinuityPreflight.bind(service);
  service.invokeWithContinuityPreflight = (preflight, options) => {
    calls++;
    return actual(preflight, {
      ...options,
      spawnCliOverride: async function* (launch) {
        const attempt = launches.length + 1;
        launches.push(launch);
        launch.onStdinReady((input) => writes.push(input));
        yield {
          event: 'init',
          conversation_id: 'same-native',
          init: {
            agent: launch.args[launch.args.indexOf('--agent') + 1],
            cwd: launch.cwd,
            model: 'gemini-3.8-flash-high',
            permission_mode: 'always-proceed',
            tools: ['write_to_file'],
          },
        };
        if (attempt === 2) {
          const events = await writer.readActiveEvents({
            sessionId: record.id,
            threadId,
            catId: record.catId,
            seq: record.seq,
          });
          assert.equal(
            events.filter((row) => row.event.type === 'request_generation_terminal')[0]?.event.outcome,
            'error',
            'old failure must be durable before continuation runs',
          );
          assert.equal(launch.args[launch.args.indexOf('--conversation') + 1], 'same-native');
        }
        const index = attempt === 1 ? 0 : 4;
        yield step(index, { step_type: 'user_input' });
        yield step(index + 1, { step_type: 'agent_response' });
        if (attempt === 1 || mode !== 'auth-again') {
          yield step(index + 2, {
            step_type: 'tool',
            state: 'ACTIVE',
            tool_name: 'write_to_file',
            tool_info:
              attempt === 1 && Object.hasOwn(evidence, 'activeToolInfo')
                ? evidence.activeToolInfo
                : { parameters: { TargetFile: effect } },
          });
          appendFileSync(effect, attempt === 1 ? 'A\n' : 'B\n');
          if (mode !== 'unknown-result')
            yield step(index + 2, {
              step_type: 'tool',
              tool_name: 'write_to_file',
              tool_info:
                attempt === 1 && Object.hasOwn(evidence, 'doneToolInfo')
                  ? evidence.doneToolInfo
                  : { parameters: { TargetFile: effect } },
            });
        }
        if (attempt === 1 || mode === 'auth-again') {
          if (mode === 'cancelled') controller.abort();
          const unparsed = {
            'missing-event': { step_update: { step_type: 'tool', state: 'ACTIVE' } },
            'unknown-event': { event: 'future_native_effect' },
            'malformed-json': { __parseError: true, line: '{"event":"step_update"' },
            'scalar-event': 'unparsed native operation',
            'liveness-warning': { __livenessWarning: true, level: 'slow', silenceDurationMs: 1000 },
          }[mode];
          if (unparsed !== undefined) yield unparsed;
          const unconfirmed = {
            'unknown-step': { step_type: 'future_native_effect' },
            'anonymous-completion': { step_type: 'unknown', state: 'DONE', duration_seconds: 0.246786 },
            'unnamed-tool': { step_type: 'tool' },
            'blank-tool': { step_type: 'tool', tool_name: ' ' },
            'missing-step-index': { step_type: 'tool', tool_name: 'write_to_file', step_index: undefined },
            'fractional-step-index': { step_type: 'tool', tool_name: 'write_to_file', step_index: 2.5 },
            'changed-tool-name': { step_type: 'tool', tool_name: 'run_command', state: 'DONE', step_index: index + 2 },
            'changed-step-type': { step_type: 'system_message', state: 'DONE', step_index: index + 2 },
            'missing-step-owner': {
              step_type: 'tool',
              tool_name: 'write_to_file',
              state: 'DONE',
              conversation_id: undefined,
            },
            'unfinished-agent-step': { step_type: 'agent_response' },
          }[mode];
          if (unconfirmed) {
            appendFileSync(effect, 'X\n');
            yield step(index + 3, { state: 'ACTIVE', ...unconfirmed });
          }
          yield step(index + 4, { step_type: 'error_message' });
          yield {
            event: 'result',
            result: {
              conversation_id:
                mode === 'foreign-terminal-owner'
                  ? 'another-native'
                  : mode === 'missing-terminal-owner'
                    ? undefined
                    : 'same-native',
              status: 'ERROR',
              ...(mode === 'malformed-terminal' ? {} : { response: '' }),
              error: mode === 'permission-auth' ? 'Error 403 Forbidden API' : 'Error 401 UNAUTHENTICATED',
              ...evidence.terminalFields,
              num_turns: attempt,
            },
          };
          yield error();
        } else {
          yield step(index + 3, { step_type: 'agent_response', text: 'Remaining work complete.' });
          yield {
            event: 'result',
            result: {
              conversation_id: 'same-native',
              status: 'SUCCESS',
              response: 'Remaining work complete.',
              num_turns: attempt,
            },
          };
        }
      },
    });
  };
  const capacitySnapshot = await resolveInvocationCapacitySnapshot({
    catId: 'gemini38',
    threadId,
    service,
    sessionChainStore: chain,
  });
  const messages = [];
  for await (const message of invokeSingleCat(
    {
      registry: {
        create: () => ({ invocationId: `inv-${threadId}`, callbackToken: 'fixture-token' }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => runtimeSessionId,
        store: async (_u, _c, _t, id) => {
          runtimeSessionId = id;
        },
        delete: async () => {
          runtimeSessionId = undefined;
        },
        resolveWorkingDirectory: () => workspace,
      },
      sessionChainStore: chain,
      transcriptWriter: writer,
      sessionSealer: new SessionSealer(chain, writer),
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      threadStore: {
        get: async () => ({ projectPath: workspace, createdBy: 'owner' }),
        updateParticipantActivity: async () => {},
      },
      ...(mode === 'presentation'
        ? {
            memoryCuePromptService: {
              resolve: async () => ({
                promptSegment: '',
                admittedOpportunityIds: [],
                omittedOpportunityIds: ['omitted-before-auth'],
                deliveryReceipts: [],
                presentationEnvelopes: [],
              }),
            },
          }
        : {}),
      apiUrl: 'http://127.0.0.1:3102',
    },
    {
      catId: 'gemini38',
      service,
      prompt: 'ORIGINAL_WORK: write A once then B',
      threadId,
      userId: 'owner',
      isLastCat: true,
      ...(mode === 'presentation'
        ? {
            memoryCueOpportunitySeeds: [{ kind: 'subject_seen', producer: 'entity_nudge', occurredAt: 1, payload: {} }],
          }
        : {}),
      capacitySnapshot,
      signal: controller.signal,
      contextPromptFactory: async () => {
        factoryCalls++;
        return { prompt: 'ORIGINAL_WORK: write A once then B', promptMessageIds: [], deltaSize: 'small' };
      },
      rebuildPromptAfterSessionSeal: async () => 'ORIGINAL_WORK cold rebuild must never run',
    },
  ))
    messages.push(message);
  const current = await chain.get(record.id);
  const events = await writer.readActiveEvents({
    sessionId: record.id,
    threadId,
    catId: record.catId,
    seq: record.seq,
  });
  await writer.flush({ sessionId: record.id, threadId, catId: record.catId, seq: record.seq });
  return {
    calls,
    launches,
    writes,
    factoryCalls,
    messages,
    current,
    chain: await chain.getChain('gemini38', threadId, 'owner'),
    events: events.map((row) => row.event),
    effects: readFileSync(effect, 'utf8'),
  };
}
