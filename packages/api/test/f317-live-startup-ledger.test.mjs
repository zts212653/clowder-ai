import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

ensureFakeCliOnPath('codex');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (const [phase, disposition] of [
  ['preflight', 'closed'],
  ['commit', 'closed'],
  ['commit', 'failed'],
  ['commit', 'accepted'],
]) {
  test(`real Host invocation records ${disposition} during Live ${phase}`, { timeout: 8000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'f317-startup-ledger-'));
    const writer = new TranscriptWriter({ dataDir });
    const append = writer.appendDurableEvent.bind(writer);
    const pending = deferred();
    const entered = deferred();
    const finished = deferred();
    const fixture = wireFixture();
    const write = fixture.wire.write;
    fixture.wire.write = async (message) => {
      await write(message);
      if (message.method === 'configRequirements/read') fixture.push({ id: message.id, result: { requirements: {} } });
      if (message.method === 'account/read') fixture.push({ id: message.id, result: { account: { type: 'chatgpt' } } });
    };
    const executionStore = new InMemoryTurnExecutionStore();
    const active = {
      id: 'session-startup',
      seq: 0,
      status: 'active',
      catId: 'codex',
      threadId: 'home',
      userId: 'owner',
    };
    const durable = [];
    let readyCalls = 0;
    let freshnessReinvokes = 0;
    writer.appendDurableEvent = async (session, event, invocationId) => {
      await append(session, event, invocationId);
      durable.push(event);
      if (phase === 'commit' && event.type === 'request_generation_assembled') {
        entered.resolve();
        await pending.promise;
      }
    };
    const service = new CodexAgentService({ carrierMode: 'app_server', l0CompilerFn: async () => 'HOST-L0' });
    const invoke = service.invoke.bind(service);
    service.invoke = (prompt, options) =>
      invoke(prompt, { ...options, agentCarrierSessionFactory: async () => fixture.wire });
    const invokePreflight = service.invokeWithContinuityPreflight.bind(service);
    service.invokeWithContinuityPreflight = (prompt, options) =>
      invokePreflight(prompt, { ...options, agentCarrierSessionFactory: async () => fixture.wire });
    const drain = (async () => {
      const messages = [];
      for await (const message of invokeSingleCat(
        {
          registry: {
            create: async () => ({ invocationId: 'startup-ledger', callbackToken: 'synthetic-only' }),
            verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
          },
          sessionManager: {
            get: async () => undefined,
            getOrCreate: async () => ({}),
            store: async () => {},
            delete: async () => {},
            resolveWorkingDirectory: () => dataDir,
          },
          sessionChainStore: {
            getChain: async () => [active],
            getActive: async () => active,
            get: async () => active,
            create: async () => active,
            update: async (_id, patch) => Object.assign(active, patch),
          },
          transcriptWriter: writer,
          turnExecutionStore: executionStore,
          contextEpochOwner: {
            resolve: async (input) => ({
              scopeKey: 'owner::codex::home',
              contextEpoch: 1,
              contextMode: 'cold',
              lastTransitionRef: input.disposition.evidenceRef,
              consumedCompactionEventIds: [],
              transition: 'scope_first_seen',
              normalizedDisposition: input.disposition,
              healthSignals: [],
            }),
            observeCompaction: async () => assert.fail('unexpected compaction'),
            confirmColdConsumed: async () => {},
          },
          freshnessReinvokeCheck: async () => {
            freshnessReinvokes++;
            return null;
          },
          threadStore: null,
          apiUrl: 'http://127.0.0.1:3004',
        },
        {
          catId: 'codex',
          service,
          prompt: 'Host-owned bootstrap',
          contextPromptFactory: async () => {
            if (phase === 'preflight') {
              entered.resolve();
              await pending.promise;
            }
            return { prompt: 'Host-owned full context', promptMessageIds: ['bootstrap'] };
          },
          userId: 'owner',
          threadId: 'home',
          isLastCat: true,
          liveCompanion: {
            finished: finished.promise,
            configure: async () => ({ mcp_servers: {} }),
            ready: async () => {
              readyCalls++;
              finished.resolve();
            },
            observe: async () => {},
          },
        },
      ))
        messages.push(message);
      return messages;
    })();
    try {
      await Promise.race([
        entered.promise,
        drain.then((messages) =>
          assert.fail(
            `setup ended before held ${phase}: ${JSON.stringify(messages.filter((message) => message.type === 'error'))}`,
          ),
        ),
      ]);
      if (disposition === 'closed') finished.resolve();
      if (disposition === 'failed') finished.reject(new Error('native call failed during commit'));
      pending.resolve();
      const messages = await drain;
      const terminals = durable.filter((event) => event.type === 'request_generation_terminal');
      assert.equal(
        fixture.writes.filter((row) => row.method === 'turn/start').length,
        disposition === 'accepted' ? 1 : 0,
      );
      assert.equal(readyCalls, disposition === 'accepted' ? 1 : 0);
      assert.deepEqual(
        terminals.map((event) => event.outcome),
        phase === 'preflight'
          ? []
          : [disposition === 'closed' ? 'cancelled' : disposition === 'failed' ? 'error' : 'accepted'],
      );
      const execution = await executionStore.get('startup-ledger');
      assert.equal(
        execution.status,
        disposition === 'closed' ? 'canceled' : disposition === 'failed' ? 'failed' : 'succeeded',
      );
      const done = messages.findLast((message) => message.type === 'done');
      assert.equal(
        done.errorCode,
        disposition === 'closed'
          ? 'INVOCATION_CANCELLED'
          : disposition === 'failed'
            ? 'PROVIDER_EXECUTION_FAILED'
            : undefined,
      );
      assert.equal(freshnessReinvokes, 0, 'canonical Queue progression does not reinvoke the retired freshness runner');
      if (disposition === 'closed')
        assert.equal(
          messages.filter((message) => message.type === 'error').length,
          0,
          'Stop is not a retryable failure',
        );
      // Read the actual durable transcript, independently of the writer's captured calls.
      const entries = await readdir(dataDir, { recursive: true });
      const contents = await Promise.all(
        entries.filter((path) => path.endsWith('.jsonl')).map((path) => readFile(join(dataDir, path), 'utf8')),
      );
      const persisted = contents.flatMap((body) => body.trim().split('\n').filter(Boolean).map(JSON.parse));
      assert.deepEqual(
        persisted.filter((row) => row.event?.type === 'request_generation_terminal').map((row) => row.event.outcome),
        terminals.map((event) => event.outcome),
      );
    } finally {
      pending.resolve();
      finished.resolve();
      await drain;
      await writer.flush({ sessionId: active.id, threadId: active.threadId, catId: active.catId, seq: active.seq });
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
