import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getCodexCarrierMode } from '../dist/config/codex-cli.js';
import { ClaudeAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';
import { ClaudeNativeToolBoundaryClassifier } from '../dist/domains/cats/services/agents/providers/claude-native-tool-boundary.js';
import {
  classifyCodexProtocolItem,
  classifyCodexSafeBoundary,
} from '../dist/domains/cats/services/agents/providers/codex-app-server-boundary.js';
import { KimiAgentService } from '../dist/domains/cats/services/agents/providers/KimiAgentService.js';
import { createProviderNativeFreshnessFactory } from '../dist/domains/cats/services/freshness/createProviderNativeFreshnessFactory.js';
import { FreshnessAttentionEventLog } from '../dist/domains/cats/services/freshness/FreshnessAttentionEventLog.js';
import {
  createContentFreeFreshnessNotice,
  FreshnessNoticeBroker,
} from '../dist/domains/cats/services/freshness/FreshnessNoticeBroker.js';
import { ThreadUnseenChecker } from '../dist/domains/cats/services/freshness/ThreadUnseenChecker.js';
import { buildTmuxAgentCarrierPaneCommand } from '../dist/domains/terminal/tmux-agent-carrier-session.js';
import { buildProviderNativeFreshnessCoverage } from '../dist/infrastructure/harness-eval/freshness/provider-native-freshness-coverage.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class FakeAppServerWire {
  constructor() {
    this.inbox = new AsyncInbox();
    this.writes = [];
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') {
      this.inbox.push({
        id: message.id,
        result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'test', codexHome: '/tmp' },
      });
    } else if (message.method === 'thread/start') {
      this.inbox.push({ id: message.id, result: { thread: { id: 'thread-1', turns: [] } } });
    } else if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
    } else if (message.method === 'turn/steer') {
      this.inbox.push({ id: message.id, result: { turnId: 'turn-1' } });
    }
  }

  async close() {
    this.inbox.close();
  }
}

class FakeRedis {
  constructor() {
    this.lists = new Map();
    this.sorted = new Map();
  }
  async rpush(key, value) {
    this.lists.set(key, [...(this.lists.get(key) ?? []), value]);
  }
  async expire() {}
  async lrange(key) {
    return [...(this.lists.get(key) ?? [])];
  }
  async zadd(key, score, member) {
    const entries = (this.sorted.get(key) ?? []).filter((entry) => entry.member !== member);
    entries.push({ score: Number(score), member });
    this.sorted.set(key, entries);
  }
  async zremrangebyscore(key, minimum, maximum) {
    const min = minimum === '-inf' ? -Infinity : Number(minimum);
    const max = maximum === '+inf' ? Infinity : Number(maximum);
    this.sorted.set(
      key,
      (this.sorted.get(key) ?? []).filter((entry) => entry.score < min || entry.score > max),
    );
  }
  async zrangebyscore(key, minimum, maximum) {
    const min = Number(String(minimum).replace(/^\(/, ''));
    const maxExclusive = String(maximum).startsWith('(');
    const max = Number(String(maximum).replace(/^\(/, ''));
    return (this.sorted.get(key) ?? [])
      .filter((entry) => entry.score >= min && (maxExclusive ? entry.score < max : entry.score <= max))
      .sort((left, right) => left.score - right.score)
      .map((entry) => entry.member);
  }
}

describe('F254 D2 provider-native freshness truth', () => {
  it('carries the exact active parent into queued freshness at provider-native safe boundaries', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { createProviderNativeFreshnessFactory } = await import(
      '../dist/domains/cats/services/freshness/createProviderNativeFreshnessFactory.js'
    );
    const queue = new InvocationQueue();
    queue.enqueue({
      ownerAuthProvenance: 'strict',
      threadId: 'thread-current-parent',
      userId: 'user-1',
      content: 'continue in the active provider turn',
      source: 'user',
      targetCats: ['opus'],
      authorIntentByCatId: {
        opus: { requested: 'continue_current', boundParentInvocationId: 'parent-active' },
      },
      intent: 'execute',
    });
    const factory = createProviderNativeFreshnessFactory({
      redis: new FakeRedis(),
      cursorStore: { getSeenCursor: async () => 'seen-cursor' },
      messageStore: { getByThreadAfter: async () => [] },
      threadStore: { get: async () => ({ thinkingMode: 'debug' }) },
      getQueue: () => queue,
    });

    const controller = await factory({
      invocationId: 'parent-active',
      threadId: 'thread-current-parent',
      userId: 'user-1',
      catId: 'opus',
      provider: 'openai_codex',
      capability: {
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
      },
    });
    const notice = await controller.prepare({
      threadId: 'thread-current-parent',
      turnId: 'turn-active',
      toolSurface: 'command_execution',
    });

    assert.ok(notice, 'the current parent must receive a content-free queued freshness notice');
    assert.match(notice.text, /get_thread_context/);
  });

  it('treats a visible other-cat stream body as unread at a play-mode safe boundary', async () => {
    const visibleCatMessage = {
      id: '0000000000000002-000001-bbbbbbbb',
      visibilitySeq: 2,
      threadId: 'thread-visible-cat-message',
      userId: 'user-1',
      catId: 'codex-sol',
      content: 'visible cat analysis',
      mentions: [],
      origin: 'stream',
      timestamp: 2,
    };
    const factory = createProviderNativeFreshnessFactory({
      redis: new FakeRedis(),
      cursorStore: { getSeenCursor: async () => 'v2:0000000000000001:0000000000000001-000001-aaaaaaaa' },
      messageStore: {
        getByThreadAfter: async () => [visibleCatMessage],
        getById: async () => undefined,
      },
      threadStore: { get: async () => ({ thinkingMode: 'play' }) },
    });

    const controller = await factory({
      invocationId: 'inv-visible-cat-message',
      threadId: visibleCatMessage.threadId,
      userId: 'user-1',
      catId: 'opus',
      provider: 'openai_codex',
      capability: {
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
      },
    });
    const notice = await controller.prepare({
      threadId: visibleCatMessage.threadId,
      turnId: 'turn-visible-cat-message',
      toolSurface: 'command_execution',
    });

    assert.ok(notice, 'visible unread cat speech must produce the same freshness notice as unread user speech');
  });

  it('classifies only completed supported tool surfaces as safe boundaries', () => {
    const completed = (type) => ({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'item-1', type } },
    });

    assert.deepEqual(classifyCodexSafeBoundary(completed('commandExecution')), {
      threadId: 'thread-1',
      turnId: 'turn-1',
      toolSurface: 'command_execution',
    });
    assert.equal(classifyCodexSafeBoundary(completed('fileChange')).toolSurface, 'file_change');
    assert.equal(classifyCodexSafeBoundary(completed('mcpToolCall')).toolSurface, 'mcp_tool_call');
    assert.equal(classifyCodexSafeBoundary(completed('dynamicToolCall')).toolSurface, 'dynamic_tool_call');
    assert.equal(classifyCodexSafeBoundary(completed('collabAgentToolCall')).toolSurface, 'collab_agent_tool_call');
    assert.equal(
      classifyCodexSafeBoundary({
        ...completed('collabAgentToolCall'),
        params: {
          ...completed('collabAgentToolCall').params,
          item: { id: 'collab-failed', type: 'collabAgentToolCall', status: 'failed' },
        },
      }).toolSurface,
      'collab_agent_tool_call',
    );
    assert.equal(
      classifyCodexSafeBoundary({
        ...completed('collabAgentToolCall'),
        params: {
          ...completed('collabAgentToolCall').params,
          item: { id: 'collab-running', type: 'collabAgentToolCall', status: 'inProgress' },
        },
      }),
      null,
    );
    assert.equal(classifyCodexSafeBoundary({ ...completed('commandExecution'), method: 'item/started' }), null);
    assert.equal(classifyCodexSafeBoundary(completed('agentMessage')), null);
    for (const itemType of ['webSearch', 'imageView', 'imageGeneration', 'sleep', 'subAgentActivity']) {
      assert.equal(classifyCodexSafeBoundary(completed(itemType)), null, `${itemType} must not become a safe boundary`);
      assert.notEqual(classifyCodexProtocolItem(completed(itemType)).classification, 'unknown');
    }
  });

  it('classifies a future ThreadItem as bounded unknown data instead of throwing', () => {
    assert.deepEqual(
      classifyCodexProtocolItem({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { id: 'future-1', type: 'futureTool', status: 'completed' },
        },
      }),
      {
        itemType: 'unknown',
        status: 'completed',
        classification: 'unknown',
        toolSurface: 'unknown',
        boundedUnknownSample: 'futureTool',
      },
    );
  });

  it('keeps opportunity, delivered, and seen separate while coalescing a frontier', async () => {
    const events = [];
    let unseen = { count: 1, senders: ['you'], maxMessageId: 'm-1' };
    const broker = new FreshnessNoticeBroker({
      context: { invocationId: 'inv-1', threadId: 'thread-1', catId: 'codex-sol' },
      checkUnseen: async () => unseen,
      appendEvent: async (event) => events.push(event),
      now: () => 123,
    });

    const prepared = await broker.prepare({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
      toolSurface: 'command_execution',
      turnId: 'turn-1',
    });
    assert.ok(prepared);
    assert.equal(
      events.some((event) => event.kind === 'provider_notice_delivered'),
      false,
    );
    assert.equal(events.filter((event) => event.kind === 'provider_notice_opportunity').length, 1);
    assert.equal(events.filter((event) => event.kind === 'provider_notice_prepared').length, 1);

    await broker.commitDelivered(prepared, { acceptedTurnId: 'turn-1' });
    assert.equal(events.filter((event) => event.kind === 'provider_notice_delivered').length, 1);
    assert.equal(
      events.some((event) => event.kind === 'queued_seen'),
      false,
    );
    assert.equal(
      await broker.prepare({
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
        toolSurface: 'file_change',
        turnId: 'turn-1',
      }),
      null,
    );

    unseen = { count: 2, senders: ['you'], maxMessageId: 'm-2' };
    assert.ok(
      await broker.prepare({
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
        toolSurface: 'file_change',
        turnId: 'turn-1',
      }),
    );
  });

  it('projects delivered to seen only after exact Queue read, then handled on same-invocation success', async () => {
    const eventLog = new FreshnessAttentionEventLog(new FakeRedis());
    const delivered = {
      kind: 'provider_notice_delivered',
      threadId: 'thread-1',
      catId: 'codex-sol',
      invocationId: 'inv-1',
      timestamp: 100,
      noticeId: 'notice-1',
      frontier: 'message-2',
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
      toolSurface: 'command_execution',
      expectedTurnId: 'turn-1',
      acceptedTurnId: 'turn-1',
    };
    await eventLog.append(delivered);
    assert.equal(
      await eventLog.markProviderNoticesSeen({
        invocationId: 'inv-1',
        catId: 'codex-sol',
        exactMessageIds: ['message-1'],
        evidenceKind: 'queue_exact_read',
      }),
      0,
    );
    assert.equal(
      await eventLog.markProviderNoticesSeen({
        invocationId: 'inv-1',
        catId: 'codex-sol',
        exactMessageIds: ['message-1', 'message-2'],
        evidenceKind: 'queue_exact_read',
      }),
      1,
    );
    assert.equal(
      await eventLog.markProviderNoticesHandled({
        invocationId: 'inv-1',
        catId: 'codex-sol',
        queueEntryId: 'queue-1',
        messageIds: ['message-2'],
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-1' },
      }),
      1,
    );
    const events = await eventLog.queryByInvocation('inv-1');
    assert.deepEqual(
      events.map((event) => event.kind),
      ['provider_notice_delivered', 'provider_notice_seen', 'provider_notice_handled'],
    );
  });

  it('correlates a queued-only synthetic frontier with exact Queue message identities', async () => {
    const queueMessageId = 'queued-message-1';
    const mergedMessageId = 'queued-message-2';
    const queueEntries = [
      {
        entryId: 'queue-1',
        source: 'user',
        content: 'exact queued body',
        messageId: queueMessageId,
        mergedMessageIds: [mergedMessageId],
      },
    ];
    const unseenChecker = new ThreadUnseenChecker({
      userId: 'user-1',
      cursorStore: { getSeenCursor: async () => 'seen-cursor' },
      messageStore: { getByThreadAfter: async () => [] },
      queueChecker: {
        getQueuedForThread: () => queueEntries,
      },
    });
    const eventLog = new FreshnessAttentionEventLog(new FakeRedis());
    const broker = new FreshnessNoticeBroker({
      context: { invocationId: 'inv-queued', threadId: 'thread-1', catId: 'codex-sol' },
      checkUnseen: () => unseenChecker.checkUnseen({ threadId: 'thread-1', catId: 'codex-sol' }),
      appendEvent: (event) => eventLog.append(event),
      now: () => 200,
    });

    const prepared = await broker.prepare({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
      toolSurface: 'command_execution',
      turnId: 'turn-queued',
    });
    assert.ok(prepared);
    assert.notEqual(prepared.frontier, queueMessageId, 'cursor-safe frontier remains synthetic');
    await broker.commitDelivered(prepared, { acceptedTurnId: 'turn-queued' });

    assert.equal(
      await broker.prepare({
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
        toolSurface: 'command_execution',
        turnId: 'turn-queued-duplicate',
      }),
      null,
      'the same unread Queue identity must not be re-steered at a later boundary',
    );

    const laterMergedMessageId = 'queued-message-3';
    queueEntries[0].mergedMessageIds.push(laterMergedMessageId);
    const newlyEligible = await broker.prepare({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
      toolSurface: 'command_execution',
      turnId: 'turn-queued-new-identity',
    });
    assert.ok(newlyEligible, 'a newly coalesced durable message must permit one new notice');
    assert.deepEqual(newlyEligible.correlationMessageIds, [queueMessageId, mergedMessageId, laterMergedMessageId]);
    await broker.commitDelivered(newlyEligible, { acceptedTurnId: 'turn-queued-new-identity' });
    queueEntries[0].mergedMessageIds.reverse();
    assert.equal(
      await broker.prepare({
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
        toolSurface: 'command_execution',
        turnId: 'turn-queued-new-identity-duplicate',
      }),
      null,
      'the newly coalesced identity must also be eligible only once',
    );

    assert.equal(
      await eventLog.markProviderNoticesSeen({
        invocationId: 'inv-queued',
        catId: 'codex-sol',
        exactMessageIds: [queueMessageId],
        evidenceKind: 'queue_exact_read',
      }),
      0,
      'a partial read of a coalesced Queue entry must fail closed',
    );
    assert.equal(
      await eventLog.markProviderNoticesSeen({
        invocationId: 'inv-queued',
        catId: 'codex-sol',
        exactMessageIds: [queueMessageId, mergedMessageId, laterMergedMessageId],
        evidenceKind: 'queue_exact_read',
      }),
      2,
    );
    assert.equal(
      await eventLog.markProviderNoticesHandled({
        invocationId: 'inv-queued',
        catId: 'codex-sol',
        queueEntryId: 'queue-1',
        messageIds: [queueMessageId, mergedMessageId, laterMergedMessageId],
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-queued' },
      }),
      2,
    );

    const events = await eventLog.queryByInvocation('inv-queued');
    const delivered = events.filter((event) => event.kind === 'provider_notice_delivered');
    assert.deepEqual(
      delivered.map((event) => event.correlationMessageIds),
      [
        [queueMessageId, mergedMessageId],
        [queueMessageId, mergedMessageId, laterMergedMessageId],
      ],
    );
    assert.deepEqual(
      events.map((event) => event.kind),
      [
        'provider_notice_opportunity',
        'provider_notice_prepared',
        'provider_notice_delivered',
        'provider_notice_opportunity',
        'provider_notice_prepared',
        'provider_notice_delivered',
        'provider_notice_seen',
        'provider_notice_seen',
        'provider_notice_handled',
        'provider_notice_handled',
      ],
    );
  });

  it('fails closed when a queued-only frontier has no durable message identity', async () => {
    const unseenChecker = new ThreadUnseenChecker({
      userId: 'user-1',
      cursorStore: { getSeenCursor: async () => 'seen-cursor' },
      messageStore: { getByThreadAfter: async () => [] },
      queueChecker: {
        getQueuedForThread: () => [
          {
            entryId: 'queue-missing-id',
            source: 'user',
            content: 'queued body without durable identity',
          },
        ],
      },
    });
    const eventLog = new FreshnessAttentionEventLog(new FakeRedis());
    const broker = new FreshnessNoticeBroker({
      context: { invocationId: 'inv-missing-id', threadId: 'thread-1', catId: 'codex-sol' },
      checkUnseen: () => unseenChecker.checkUnseen({ threadId: 'thread-1', catId: 'codex-sol' }),
      appendEvent: (event) => eventLog.append(event),
      now: () => 300,
    });

    const prepared = await broker.prepare({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
      toolSurface: 'command_execution',
      turnId: 'turn-missing-id',
    });
    assert.ok(prepared);
    assert.deepEqual(prepared.correlationMessageIds, []);
    await broker.commitDelivered(prepared, { acceptedTurnId: 'turn-missing-id' });
    assert.equal(
      await broker.prepare({
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
        toolSurface: 'command_execution',
        turnId: 'turn-missing-id-duplicate',
      }),
      null,
      'missing receipt identity must remain fail-closed without repeat-steering the same Queue entry',
    );

    assert.equal(
      await eventLog.markProviderNoticesSeen({
        invocationId: 'inv-missing-id',
        catId: 'codex-sol',
        exactMessageIds: [prepared.frontier],
        evidenceKind: 'queue_exact_read',
      }),
      0,
      'the synthetic cursor frontier cannot substitute for missing Queue identity',
    );
  });

  it('keeps MCP-only evidence partial in provider by tool-surface eval', () => {
    const base = {
      threadId: 'thread-1',
      catId: 'codex-sol',
      invocationId: 'inv-1',
      timestamp: 100,
      noticeId: 'notice-1',
      frontier: 'message-1',
      provider: 'anthropic',
      carrier: 'mcp_result_piggyback',
      deliverySemantics: 'mcp_result_piggyback',
      toolSurface: 'mcp_tool_call',
      expectedTurnId: 'turn-1',
    };
    const report = buildProviderNativeFreshnessCoverage([
      { ...base, kind: 'provider_notice_opportunity' },
      { ...base, kind: 'provider_notice_delivered', acceptedTurnId: 'turn-1' },
      { ...base, kind: 'provider_notice_seen', seenMessageIds: ['message-1'], evidenceKind: 'queue_exact_read' },
    ]);
    assert.equal(report.verdict, 'partial');
    assert.equal(report.carriers[0].allToolCoverage, false);
    assert.deepEqual(report.carriers[0].missingSurfaces.sort(), [
      'command_execution',
      'dynamic_tool_call',
      'file_change',
    ]);
  });

  it('puts explicit unsupported and unknown completed items in the coverage denominator', () => {
    const capability = {
      threadId: 'thread-1',
      catId: 'kimi',
      invocationId: 'inv-kimi',
      timestamp: 100,
      kind: 'provider_carrier_capability_declared',
      provider: 'kimi',
      carrier: 'kimi_stream_json',
      deliverySemantics: 'unsupported',
    };
    const unknown = {
      threadId: 'thread-1',
      catId: 'codex-sol',
      invocationId: 'inv-codex',
      timestamp: 101,
      kind: 'provider_protocol_item_observed',
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
      toolSurface: 'unknown',
      itemType: 'unknown',
      boundedUnknownSample: 'futureTool',
      status: 'completed',
      classification: 'unknown',
    };
    const report = buildProviderNativeFreshnessCoverage([capability, unknown]);

    assert.equal(report.verdict, 'partial');
    assert.equal(report.carriers.find((row) => row.provider === 'kimi').dataStatus, 'no_data');
    assert.equal(report.carriers.find((row) => row.provider === 'kimi').allToolCoverage, false);
    assert.equal(report.carriers.find((row) => row.provider === 'openai_codex').unknownItemCount, 1);
    assert.equal(report.cells.find((cell) => cell.toolSurface === 'unknown').observedCount, 1);
  });

  it('builds a content-free notice with no Queue body or sender preview', () => {
    const text = createContentFreeFreshnessNotice({ threadId: 'thread-1', unseenCount: 3 });
    assert.match(text, /get_thread_context/);
    assert.match(text, /thread-1/);
    assert.match(text, /responseMode.*full/);
    assert.doesNotMatch(text, /list_recent/);
    assert.doesNotMatch(text, /secret body|landy/);
  });

  it('steers the exact active turn after a native command completion', async () => {
    const wire = new FakeAppServerWire();
    const delivered = [];
    const missed = [];
    const client = new CodexAppServerClient({
      wire,
      freshnessController: {
        prepare: async (boundary) => ({
          noticeId: 'notice-1',
          frontier: 'm-1',
          expectedTurnId: boundary.turnId,
          text: '📬 freshness notice: read the current thread in full',
          boundary,
        }),
        commitDelivered: async (notice, result) => delivered.push({ notice, result }),
        markMissed: async (notice, reason) => missed.push({ notice, reason }),
        markTurnCompleted: async () => {},
      },
    });

    const output = [];
    const run = (async () => {
      for await (const event of client.run({ prompt: { kind: 'frozen', prompt: 'work' }, thread: { kind: 'start' } }))
        output.push(event);
    })();

    while (!wire.writes.some((write) => write.method === 'turn/start'))
      await new Promise((resolve) => setImmediate(resolve));
    wire.inbox.push({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1,
        item: { id: 'cmd-1', type: 'commandExecution', command: 'echo ok', status: 'completed' },
      },
    });

    while (!wire.writes.some((write) => write.method === 'turn/steer'))
      await new Promise((resolve) => setImmediate(resolve));
    wire.inbox.push({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    await run;

    const steer = wire.writes.find((write) => write.method === 'turn/steer');
    assert.equal(steer.params.expectedTurnId, 'turn-1');
    assert.equal(steer.params.threadId, 'thread-1');
    assert.deepEqual(steer.params.input, [
      { type: 'text', text: '📬 freshness notice: read the current thread in full' },
    ]);
    assert.equal(delivered.length, 1);
    assert.equal(missed.length, 0);
    assert.equal(
      output.some((event) => event.type === 'turn.completed'),
      true,
    );
  });

  it('records an unknown completed app-server item as bounded protocol telemetry', async () => {
    const wire = new FakeAppServerWire();
    const observed = [];
    const client = new CodexAppServerClient({
      wire,
      freshnessController: {
        prepare: async () => null,
        commitDelivered: async () => {},
        markMissed: async () => {},
        markTurnCompleted: async () => {},
        observeProtocolItem: async (observation) => observed.push(observation),
      },
    });
    const run = (async () => {
      for await (const _event of client.run({
        prompt: { kind: 'frozen', prompt: 'work' },
        thread: { kind: 'start' },
      })) {
        /* drain */
      }
    })();
    while (!wire.writes.some((write) => write.method === 'turn/start')) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    wire.inbox.push({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'future-1', type: 'futureTool', status: 'completed' },
      },
    });
    wire.inbox.push({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await run;

    assert.deepEqual(observed, [
      {
        itemType: 'unknown',
        status: 'completed',
        classification: 'unknown',
        toolSurface: 'unknown',
        boundedUnknownSample: 'futureTool',
      },
    ]);
  });

  it('bounds unknown item samples while retaining every normalized observation', async () => {
    const events = [];
    const broker = new FreshnessNoticeBroker({
      context: { invocationId: 'inv-unknown', threadId: 'thread-1', catId: 'codex-sol' },
      checkUnseen: async () => null,
      appendEvent: async (event) => events.push(event),
      now: () => 123,
    });
    const capability = {
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
    };
    for (let index = 0; index < 10; index++) {
      await broker.observeProtocolItem(capability, {
        itemType: 'unknown',
        status: 'completed',
        classification: 'unknown',
        toolSurface: 'unknown',
        boundedUnknownSample: `futureTool${index}`,
      });
    }

    assert.equal(events.length, 10);
    assert.equal(events.filter((event) => event.boundedUnknownSample !== undefined).length, 8);
    assert.equal(
      events.every((event) => event.itemType === 'unknown'),
      true,
    );
  });

  it('records a turn mismatch as missed and never retargets another turn', async () => {
    const wire = new FakeAppServerWire();
    wire.write = async function write(message) {
      this.writes.push(message);
      if (message.method === 'initialize') this.inbox.push({ id: message.id, result: {} });
      else if (message.method === 'thread/start')
        this.inbox.push({ id: message.id, result: { thread: { id: 'thread-1' } } });
      else if (message.method === 'turn/start') this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1' } } });
      else if (message.method === 'turn/steer') this.inbox.push({ id: message.id, result: { turnId: 'turn-2' } });
    };
    const missed = [];
    const client = new CodexAppServerClient({
      wire,
      freshnessController: {
        prepare: async (boundary) => ({
          noticeId: 'n',
          frontier: 'm',
          expectedTurnId: boundary.turnId,
          text: 'notice',
          boundary,
        }),
        commitDelivered: async () => assert.fail('mismatched turn must not commit delivered'),
        markMissed: async (_notice, reason) => missed.push(reason),
        markTurnCompleted: async () => {},
      },
    });
    const run = (async () => {
      for await (const _event of client.run({
        prompt: { kind: 'frozen', prompt: 'work' },
        thread: { kind: 'start' },
      })) {
        /* drain */
      }
    })();
    while (!wire.writes.some((write) => write.method === 'turn/start'))
      await new Promise((resolve) => setImmediate(resolve));
    wire.inbox.push({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'c', type: 'commandExecution' } },
    });
    while (missed.length === 0) await new Promise((resolve) => setImmediate(resolve));
    wire.inbox.push({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    await run;
    assert.deepEqual(missed, ['turn_mismatch']);
    assert.equal(wire.writes.filter((write) => write.method === 'turn/steer').length, 1);
  });

  it('ignores tool completions that do not belong to the exact active thread and turn', async () => {
    const wire = new FakeAppServerWire();
    let prepareCalls = 0;
    let observedCalls = 0;
    const client = new CodexAppServerClient({
      wire,
      freshnessController: {
        prepare: async () => {
          prepareCalls++;
          return null;
        },
        commitDelivered: async () => {},
        markMissed: async () => {},
        markTurnCompleted: async () => {},
        observeProtocolItem: async () => {
          observedCalls++;
        },
      },
    });
    const run = (async () => {
      for await (const _event of client.run({
        prompt: { kind: 'frozen', prompt: 'work' },
        thread: { kind: 'start' },
      })) {
        /* drain */
      }
    })();
    while (!wire.writes.some((write) => write.method === 'turn/start'))
      await new Promise((resolve) => setImmediate(resolve));
    wire.inbox.push({
      method: 'item/completed',
      params: { threadId: 'foreign-thread', turnId: 'turn-1', item: { id: 'c1', type: 'commandExecution' } },
    });
    wire.inbox.push({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'foreign-turn', item: { id: 'c2', type: 'fileChange' } },
    });
    wire.inbox.push({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await run;
    assert.equal(prepareCalls, 0);
    assert.equal(observedCalls, 0);
    assert.equal(
      wire.writes.some((write) => write.method === 'turn/steer'),
      false,
    );
  });

  it('does not relabel an accepted steer as missed when delivery telemetry persistence fails', async () => {
    const wire = new FakeAppServerWire();
    const missed = [];
    const client = new CodexAppServerClient({
      wire,
      freshnessController: {
        prepare: async (boundary) => ({
          noticeId: 'notice-telemetry',
          frontier: 'm-1',
          expectedTurnId: boundary.turnId,
          text: 'notice',
          boundary,
          provider: 'openai_codex',
          carrier: 'codex_app_server',
          deliverySemantics: 'exact_active_turn',
        }),
        commitDelivered: async () => {
          throw new Error('redis unavailable');
        },
        markMissed: async (_notice, reason) => missed.push(reason),
        markTurnCompleted: async () => {},
      },
    });
    const run = (async () => {
      for await (const _event of client.run({
        prompt: { kind: 'frozen', prompt: 'work' },
        thread: { kind: 'start' },
      })) {
        /* drain */
      }
    })();
    while (!wire.writes.some((write) => write.method === 'turn/start'))
      await new Promise((resolve) => setImmediate(resolve));
    wire.inbox.push({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'c', type: 'commandExecution' } },
    });
    while (!wire.writes.some((write) => write.method === 'turn/steer'))
      await new Promise((resolve) => setImmediate(resolve));
    wire.inbox.push({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await run;
    assert.deepEqual(missed, []);
  });

  it('fails closed on app-server approval requests while preserving the active turn', async () => {
    const wire = new FakeAppServerWire();
    const client = new CodexAppServerClient({ wire });
    const run = (async () => {
      for await (const _event of client.run({
        prompt: { kind: 'frozen', prompt: 'work' },
        thread: { kind: 'start' },
      })) {
        /* drain */
      }
    })();
    while (!wire.writes.some((write) => write.method === 'turn/start'))
      await new Promise((resolve) => setImmediate(resolve));
    wire.inbox.push({ id: 81, method: 'item/commandExecution/requestApproval', params: {} });
    wire.inbox.push({ id: 82, method: 'unknown/request', params: {} });
    wire.inbox.push({
      id: 83,
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          {
            id: 'mcp_tool_call_approval_exec-1',
            header: 'Approve GitHub write',
            question: 'Allow GitHub create_pull_request?',
            options: [],
          },
        ],
      },
    });
    while (!wire.writes.some((write) => write.id === 83)) await new Promise((resolve) => setImmediate(resolve));
    wire.inbox.push({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await run;
    assert.deepEqual(wire.writes.find((write) => write.id === 81).result, { decision: 'decline' });
    assert.equal(wire.writes.find((write) => write.id === 82).error.code, -32601);
    assert.deepEqual(wire.writes.find((write) => write.id === 83).result, {
      answers: {
        'mcp_tool_call_approval_exec-1': { answers: ['__codex_mcp_decline__'] },
      },
    });
  });

  it('resumes only the requested Codex thread id', async () => {
    const wire = new FakeAppServerWire();
    const originalWrite = wire.write.bind(wire);
    wire.write = async (message) => {
      if (message.method === 'thread/resume') {
        wire.writes.push(message);
        wire.inbox.push({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
        return;
      }
      await originalWrite(message);
      if (message.method === 'turn/start') {
        setImmediate(() =>
          wire.inbox.push({
            method: 'turn/completed',
            params: { threadId: 'thread-existing', turn: { id: 'turn-1', status: 'completed' } },
          }),
        );
      }
    };
    const client = new CodexAppServerClient({ wire });
    for await (const _event of client.run({
      prompt: { kind: 'frozen', prompt: 'continue' },
      thread: { kind: 'resume', threadId: 'thread-existing' },
    })) {
      /* drain */
    }
    const resume = wire.writes.find((write) => write.method === 'thread/resume');
    assert.equal(resume.params.threadId, 'thread-existing');
    assert.equal(
      wire.writes.some((write) => write.method === 'thread/start'),
      false,
    );
  });

  it('keeps exec_json as default and selects app_server only by explicit opt-in', () => {
    assert.equal(getCodexCarrierMode({}), 'exec_json');
    assert.equal(getCodexCarrierMode({ CAT_CAFE_CODEX_CARRIER: 'unknown' }), 'exec_json');
    assert.equal(getCodexCarrierMode({ CAT_CAFE_CODEX_CARRIER: ' app_server ' }), 'app_server');
  });

  it('reports carrier capability without extrapolating MCP coverage', () => {
    assert.deepEqual(
      new CodexAgentService({ carrierMode: 'exec_json', model: 'gpt-test' }).freshnessCarrierCapability(),
      {
        provider: 'openai_codex',
        carrier: 'codex_exec_json',
        deliverySemantics: 'unsupported',
      },
    );
    assert.deepEqual(
      new CodexAgentService({ carrierMode: 'app_server', model: 'gpt-test' }).freshnessCarrierCapability(),
      {
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
      },
    );
    assert.deepEqual(new ClaudeAgentService({ model: 'claude-test' }).freshnessCarrierCapability(), {
      provider: 'anthropic',
      carrier: 'claude_print_sdk',
      deliverySemantics: 'unsupported',
    });
    assert.deepEqual(new KimiAgentService({ model: 'kimi-test' }).freshnessCarrierCapability(), {
      provider: 'kimi',
      carrier: 'kimi_stream_json',
      deliverySemantics: 'unsupported',
    });
    const policy = { mode: 'read_only', allowedToolNames: [], deniedToolNames: [], replayDeniedToolNames: [] };
    assert.equal(
      new CodexAgentService({ carrierMode: 'exec_json', model: 'gpt-test' }).supportsToolExecutionPolicy(policy),
      true,
    );
    assert.equal(
      new CodexAgentService({ carrierMode: 'app_server', model: 'gpt-test' }).supportsToolExecutionPolicy(policy),
      false,
    );
  });

  it('classifies Claude native tool completion without treating replay echo as delivery proof', () => {
    const classifier = new ClaudeNativeToolBoundaryClassifier();
    assert.deepEqual(
      classifier.observe({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }] },
      }),
      [],
    );
    assert.deepEqual(
      classifier.observe({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
      }),
      ['command_execution'],
    );
    assert.deepEqual(
      classifier.observe({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'echo only' }] },
      }),
      [],
    );
  });

  it('keeps tmux protocol input on a FIFO and never embeds JSON payloads in the pane command', () => {
    const command = buildTmuxAgentCarrierPaneCommand(
      { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-1' },
      '/tmp/in.fifo',
      '/tmp/out.fifo',
      '/tmp/stderr.log',
      '/tmp/exit-code',
    );
    assert.match(command, /< '\/tmp\/in\.fifo'/);
    assert.match(command, /tee '\/tmp\/out\.fifo'/);
    assert.doesNotMatch(command, /turn\/steer|expectedTurnId|freshness notice/);
  });

  it('routes CodexAgentService through the duplex app-server session without exec replay', async () => {
    const wire = new FakeAppServerWire();
    const originalWrite = wire.write.bind(wire);
    wire.write = async (message) => {
      await originalWrite(message);
      if (message.method === 'turn/start') {
        setImmediate(() => {
          wire.inbox.push({
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              completedAtMs: 1,
              item: {
                id: 'github-write-1',
                type: 'mcpToolCall',
                server: 'codex_apps',
                tool: 'github.create_pull_request',
                status: 'failed',
                arguments: {},
                result: null,
                error: { message: 'user rejected MCP tool call' },
              },
            },
          });
          wire.inbox.push({
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              completedAtMs: 1,
              item: { id: 'answer-1', type: 'agentMessage', text: 'app-server answer' },
            },
          });
          wire.inbox.push({
            method: 'thread/tokenUsage/updated',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              tokenUsage: {
                last: {
                  inputTokens: 10,
                  outputTokens: 4,
                  cachedInputTokens: 3,
                  reasoningOutputTokens: 1,
                  totalTokens: 14,
                },
                total: {
                  inputTokens: 10,
                  outputTokens: 4,
                  cachedInputTokens: 3,
                  reasoningOutputTokens: 1,
                  totalTokens: 14,
                },
                modelContextWindow: 128000,
              },
            },
          });
          wire.inbox.push({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
          });
        });
      }
    };
    let factoryInput;
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.3-codex',
      spawnFn: () => assert.fail('app-server mode must not invoke exec spawnFn'),
    });
    const messages = [];
    for await (const message of service.invoke('work', {
      invocationId: 'inv-app-server',
      requestedServiceTier: 'standard',
      cliConfigArgs: ['--config=service_tier="fast"', '-c=service_tier="fast"', '-cservice_tier="fast"'],
      agentCarrierSessionFactory: async (input) => {
        factoryInput = input;
        return wire;
      },
    })) {
      messages.push(message);
    }

    assert.deepEqual(factoryInput.args.slice(0, 2), ['app-server', '--stdio']);
    assert.equal(factoryInput.args.includes('exec'), false);
    assert.equal(
      factoryInput.args.some((arg) => arg.includes('service_tier=')),
      false,
      'app-server process args must not retain raw service_tier overrides',
    );
    assert.ok(factoryInput.args.includes('apps._default.default_tools_approval_mode="writes"'));
    const threadStart = wire.writes.find((message) => message.method === 'thread/start');
    assert.equal(threadStart.params.serviceTier, null, 'typed Standard must reach the app-server request');
    assert.match(threadStart.params.developerInstructions, /GitHub routing/);
    assert.match(threadStart.params.developerInstructions, /GitHub MCP.*retired/i);
    assert.match(threadStart.params.developerInstructions, /canonical.*gh/i);
    assert.match(threadStart.params.developerInstructions, /merge-gate/i);
    assert.match(threadStart.params.developerInstructions, /confirmation_unavailable/);
    assert.equal(messages.find((message) => message.type === 'session_init').sessionId, 'thread-1');
    const githubWriteFailure = messages.find(
      (message) => message.toolName === 'mcp:codex_apps/github.create_pull_request',
    );
    assert.equal(githubWriteFailure.toolResultStatus, 'error');
    assert.equal(githubWriteFailure.toolResultErrorCode, 'confirmation_unavailable');
    assert.match(githubWriteFailure.content, /\[confirmation_unavailable\]/);
    assert.match(githubWriteFailure.content, /gh.*merge-gate/i);
    assert.equal(messages.find((message) => message.type === 'text').content, 'app-server answer');
    assert.equal(messages.at(-1).metadata.usage.inputTokens, 10);
    assert.equal(messages.at(-1).metadata.usage.outputTokens, 4);
    assert.equal(messages.at(-1).metadata.usage.cacheReadTokens, 3);
    assert.equal(messages.at(-1).metadata.usage.lastTurnInputTokens, 10);
    assert.equal(messages.at(-1).type, 'done');
  });

  it('archives app-server envelopes with direction and transport provenance', async () => {
    const wire = new FakeAppServerWire();
    const originalWrite = wire.write.bind(wire);
    wire.write = async (message) => {
      await originalWrite(message);
      if (message.method === 'turn/start') {
        setImmediate(() =>
          wire.inbox.push({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
          }),
        );
      }
    };
    const archived = [];
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.3-codex',
      rawArchive: { append: async (invocationId, payload) => archived.push({ invocationId, payload }) },
    });
    for await (const _message of service.invoke('work', {
      invocationId: 'inv-archive',
      auditContext: { invocationId: 'inv-archive', threadId: 'thread-1', userId: 'user-1', catId: 'codex-sol' },
      agentCarrierSessionFactory: async () => wire,
    })) {
      /* drain */
    }
    assert.equal(archived.length > 0, true);
    assert.equal(
      archived.every((entry) => entry.invocationId === 'inv-archive'),
      true,
    );
    assert.equal(
      archived.every((entry) => entry.payload.transport === 'codex_app_server'),
      true,
    );
    assert.equal(
      archived.some((entry) => entry.payload.direction === 'outbound'),
      true,
    );
    assert.equal(
      archived.some((entry) => entry.payload.direction === 'inbound'),
      true,
    );
  });

  it('projects pre-turn recovery on the internal status channel', async () => {
    const wire = new FakeAppServerWire();
    const originalWrite = wire.write.bind(wire);
    wire.write = async (message) => {
      await originalWrite(message);
      if (message.method === 'turn/start') {
        setImmediate(() =>
          wire.inbox.push({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
          }),
        );
      }
    };
    let attempts = 0;
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.3-codex',
    });
    const messages = [];
    for await (const message of service.invoke('work', {
      invocationId: 'inv-pre-turn-recovery',
      agentCarrierSessionFactory: async () => {
        attempts++;
        if (attempts === 1) throw new Error('startup transport unavailable');
        return wire;
      },
    })) {
      messages.push(message);
    }

    assert.equal(attempts, 2);
    assert.equal(
      messages.filter((message) => message.type === 'status' && message.metadata?.diagnostics?.appServerRecovery)
        .length,
      1,
    );
    assert.equal(
      messages.some(
        (message) =>
          message.type === 'system_info' &&
          typeof message.content === 'string' &&
          message.content.includes('app_server_recovery'),
      ),
      false,
    );
  });

  it('projects app-server lifecycle and routes user cancel through turn/interrupt', async () => {
    const wire = new FakeAppServerWire();
    const controller = new AbortController();
    const originalWrite = wire.write.bind(wire);
    wire.write = async (message) => {
      await originalWrite(message);
      if (message.method === 'turn/interrupt') {
        wire.inbox.push({ id: message.id, result: {} });
        setImmediate(() =>
          wire.inbox.push({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] } },
          }),
        );
      }
    };
    let factoryInput;
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.3-codex',
    });
    const messages = [];
    const run = (async () => {
      for await (const message of service.invoke('work', {
        invocationId: 'inv-protocol-cancel',
        signal: controller.signal,
        agentCarrierSessionFactory: async (input) => {
          factoryInput = input;
          return wire;
        },
      })) {
        messages.push(message);
      }
    })();

    while (!wire.writes.some((message) => message.method === 'turn/start')) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort('user_cancel');
    await run;

    assert.equal(factoryInput.signal, undefined, 'raw carrier must not race protocol cancellation with SIGINT');
    assert.deepEqual(wire.writes.find((message) => message.method === 'turn/interrupt').params, {
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    const lifecycle = messages
      .filter((message) => message.type === 'status')
      .map((message) => message.metadata?.diagnostics?.appServerLifecycle)
      .filter(Boolean);
    assert.equal(
      messages.some(
        (message) =>
          message.type === 'system_info' &&
          typeof message.content === 'string' &&
          message.content.includes('app_server_lifecycle'),
      ),
      false,
      'internal lifecycle telemetry must not use the user-visible system_info channel',
    );
    assert.equal(
      lifecycle.some((event) => event.stage === 'child_spawned'),
      true,
    );
    assert.equal(
      lifecycle.some((event) => event.stage === 'turn_accepted'),
      true,
    );
    assert.equal(
      lifecycle.some((event) => event.stage === 'interrupted'),
      true,
    );
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
    );
    assert.equal(messages.at(-1).type, 'done');
  });

  it('honors the global CLI_TIMEOUT_MS opt-in through protocol interruption', async () => {
    const previousTimeout = process.env.CLI_TIMEOUT_MS;
    process.env.CLI_TIMEOUT_MS = '20';
    const wire = new FakeAppServerWire();
    const failsafe = new AbortController();
    const originalWrite = wire.write.bind(wire);
    wire.write = async (message) => {
      await originalWrite(message);
      if (message.method === 'turn/interrupt') {
        wire.inbox.push({ id: message.id, result: {} });
        setImmediate(() =>
          wire.inbox.push({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] } },
          }),
        );
      }
    };
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.3-codex',
    });
    const messages = [];
    const failsafeTimer = setTimeout(() => failsafe.abort('test_failsafe'), 250);
    try {
      for await (const message of service.invoke('work', {
        invocationId: 'inv-protocol-timeout',
        signal: failsafe.signal,
        agentCarrierSessionFactory: async () => wire,
      })) {
        messages.push(message);
      }
    } finally {
      clearTimeout(failsafeTimer);
      if (previousTimeout === undefined) delete process.env.CLI_TIMEOUT_MS;
      else process.env.CLI_TIMEOUT_MS = previousTimeout;
    }

    const lifecycle = messages
      .filter((message) => message.type === 'status')
      .map((message) => message.metadata?.diagnostics?.appServerLifecycle)
      .filter(Boolean);
    assert.equal(
      lifecycle.some((event) => event.interruptReason === 'timeout'),
      true,
      'the process-level /config timeout must reach the app-server client',
    );
    assert.equal(
      lifecycle.some((event) => event.interruptReason === 'user_cancel'),
      false,
      'the failsafe should not be the source of interruption',
    );
  });

  it('attributes failed app-server turns without Claude Code branding', async () => {
    const wire = new FakeAppServerWire();
    const originalWrite = wire.write.bind(wire);
    wire.write = async (message) => {
      await originalWrite(message);
      if (message.method === 'turn/start') {
        setImmediate(() =>
          wire.inbox.push({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: {
                id: 'turn-1',
                status: 'failed',
                error: { message: 'future unclassified Codex app-server failure' },
                items: [],
              },
            },
          }),
        );
      }
    };
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.3-codex',
      spawnFn: () => assert.fail('failed app-server turn must not replay through exec'),
    });
    const messages = [];
    for await (const message of service.invoke('work', {
      invocationId: 'inv-failed-app-server',
      agentCarrierSessionFactory: async () => wire,
    }))
      messages.push(message);
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error.error, 'future unclassified Codex app-server failure');
    assert.ok(error.metadata.cliDiagnostics);
    assert.equal(error.metadata.cliDiagnostics.reasonCode, undefined);
    assert.equal(error.metadata.cliDiagnostics.publicSummary, '未识别的 CLI 错误');
    assert.equal(error.metadata.cliDiagnostics.excerptSource, 'unknown_raw');
    assert.doesNotMatch(error.metadata.cliDiagnostics.publicSummary, /Claude Code/);
    assert.equal(error.metadata.cliDiagnostics.debugRef.command, 'codex app-server');
    assert.equal(messages.at(-1).type, 'done');
  });
});
