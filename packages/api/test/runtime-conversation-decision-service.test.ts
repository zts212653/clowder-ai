import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  MessageFrom,
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionRequest,
} from '@cat-cafe/shared';
import {
  RuntimeInteractionError,
  RuntimeInteractionService,
} from '../src/domains/runtime-interaction/RuntimeInteractionService.js';
import { InMemoryRuntimeInteractionStore } from '../src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';

const cardRef: RuntimeInteractionCardRef = {
  threadId: 'thread-1',
  messageId: 'message-card',
  blockId: 'decision-block',
};

const presentation = {
  id: 'decision-block',
  kind: 'interactive',
  v: 1,
  interactiveType: 'select',
  title: 'Choose a release name',
  options: [
    { id: 'sunrise', label: 'Sunrise' },
    { id: 'moonrise', label: 'Moonrise' },
  ],
  messageTemplate: 'Release name: {selection}',
} as const;

function conversationRequest(interactionId = 'conversation-1'): RuntimeInteractionRequest {
  return {
    version: 1,
    interactionId,
    kind: 'conversation_decision',
    owner: {
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      invocationId: 'requester-invocation',
    },
    createdAt: 1_000,
    title: 'Choose a release name',
    presentation,
    allowTextResponse: true,
  } as unknown as RuntimeInteractionRequest;
}

type ConversationReturn = {
  interactionId: string;
  operationId: string;
  author: 'owner' | 'host';
  content: string;
};

class FakeConversationReturnGateway {
  readonly returns: ConversationReturn[] = [];
  readonly sourceMessages = new Map<
    string,
    {
      userId: string;
      threadId: string;
      from: MessageFrom;
      ownerAuthProvenance?: 'strict' | 'compatibility_fallback' | 'unknown';
      timestamp: number;
      deletedAt?: number;
      tombstone?: boolean;
    }
  >();
  failBeforeAppend = false;
  failAfterAppend = false;

  async deliver(input: ConversationReturn): Promise<{ messageId: string }> {
    if (this.failBeforeAppend) {
      this.failBeforeAppend = false;
      throw new Error('simulated crash before append');
    }
    const messageId = `response:${input.interactionId}:${input.operationId}`;
    if (
      !this.returns.some(
        (entry) => entry.interactionId === input.interactionId && entry.operationId === input.operationId,
      )
    ) {
      this.returns.push(structuredClone(input));
    }
    if (this.failAfterAppend) {
      this.failAfterAppend = false;
      throw new Error('simulated acknowledgement loss after append');
    }
    return { messageId };
  }

  async readOwnerMessage(messageId: string) {
    return this.sourceMessages.get(messageId) ?? null;
  }
}

interface ConversationService {
  createConversationDecision(request: RuntimeInteractionRequest): Promise<RuntimeInteractionRecord>;
  respond(input: {
    interactionId: string;
    ownerUserId: string;
    cardRef: RuntimeInteractionCardRef;
    expectedRevision: number;
    operationId: string;
    response: unknown;
  }): Promise<RuntimeInteractionRecord>;
  settleFromOwnerMessage(input: {
    interactionId: string;
    requester: { userId: string; threadId: string; catId: string };
    ownerMessageAuth: { ownerAuthProvenance: string; originTriggerMessageId?: string };
    expectedRevision: number;
    operationId: string;
    responseMessageId: string;
  }): Promise<RuntimeInteractionRecord>;
  withdrawConversationDecision(input: {
    interactionId: string;
    requester: { userId: string; threadId: string; catId: string };
    expectedRevision: number;
    operationId: string;
  }): Promise<RuntimeInteractionRecord>;
  supersedeConversationDecision(input: {
    interactionId: string;
    requester: { userId: string; threadId: string; catId: string };
    expectedRevision: number;
    operationId: string;
    replacementInteractionId: string;
  }): Promise<RuntimeInteractionRecord>;
  recoverConversationCreations(): Promise<RuntimeInteractionRecord[]>;
  recoverConversationSubmissions(): Promise<RuntimeInteractionRecord[]>;
  reconcileConversationDeadlines(): Promise<RuntimeInteractionRecord[]>;
  pendingConversationDecisionPrompt(
    userId: string,
    threadId: string,
    catId: string,
    originTriggerMessageId?: string,
  ): Promise<string>;
}

function makeHarness(input?: { store?: InMemoryRuntimeInteractionStore; now?: () => number; hostEpoch?: string }) {
  const store = input?.store ?? new InMemoryRuntimeInteractionStore();
  const gateway = new FakeConversationReturnGateway();
  const service = new RuntimeInteractionService({
    store,
    hostEpoch: input?.hostEpoch ?? 'host-1',
    now: input?.now ?? (() => 2_000),
    cardPublisher: {
      prepare: async () => cardRef,
      publish: async () => {},
      isLive: async () => true,
    },
    conversationReturnGateway: gateway,
  } as never) as unknown as ConversationService;
  return { store, gateway, service };
}

class FailOnceOnCompleteStore extends InMemoryRuntimeInteractionStore {
  failNextComplete = true;

  override async completeSubmission(
    input: Parameters<InMemoryRuntimeInteractionStore['completeSubmission']>[0],
  ): Promise<RuntimeInteractionRecord | null> {
    if (this.failNextComplete) {
      this.failNextComplete = false;
      throw new Error('simulated crash before terminal commit');
    }
    return super.completeSubmission(input);
  }
}

const requester = { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol' };

describe('conversation-backed runtime interactions', () => {
  it('publishes immediately without a provider waiter and allows multiple decisions in one requester invocation', async () => {
    const { service, store } = makeHarness();

    const first = await service.createConversationDecision(conversationRequest('conversation-1'));
    const second = await service.createConversationDecision(conversationRequest('conversation-2'));

    assert.equal(first.status, 'pending');
    assert.equal(second.status, 'pending');
    assert.equal(first.revision, 2);
    assert.equal(second.revision, 2);
    assert.equal(first.returnBinding.kind, 'conversation_turn');
    assert.deepEqual(
      (await store.listPendingByUser('user-1')).map((record) => record.request.interactionId),
      ['conversation-1', 'conversation-2'],
    );
  });

  it('replays the same producer identity idempotently and rejects conflicting content', async () => {
    const { service, store } = makeHarness();
    const first = await service.createConversationDecision(conversationRequest());
    const replay = await service.createConversationDecision({
      ...conversationRequest(),
      createdAt: 9_999,
    } as RuntimeInteractionRequest);

    assert.equal(replay.request.interactionId, first.request.interactionId);
    assert.equal(replay.revision, first.revision);
    assert.equal((await store.listPendingByUser('user-1')).length, 1);
    await assert.rejects(
      service.createConversationDecision({
        ...conversationRequest(),
        title: 'Conflicting retry',
      } as RuntimeInteractionRequest),
      (error: unknown) => error instanceof RuntimeInteractionError && error.code === 'duplicate',
    );
  });

  it('resumes an exact staged conversation decision after a host restart', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    await store.createStaged({ request: conversationRequest(), hostEpoch: 'old-host', now: 1_000 });
    const { service } = makeHarness({ store, hostEpoch: 'new-host' });

    const pending = await service.createConversationDecision(conversationRequest());
    assert.equal(pending.status, 'pending');
    assert.equal(pending.hostEpoch, 'new-host');
    assert.equal(pending.revision, 2);
  });

  it('recovers a staged conversation decision on startup without requiring a producer replay', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    await store.createStaged({ request: conversationRequest(), hostEpoch: 'crashed-host', now: 1_000 });
    const { service } = makeHarness({ store, hostEpoch: 'replacement-host' });

    const [recovered] = await service.recoverConversationCreations();
    assert.equal(recovered?.status, 'pending');
    assert.equal(recovered?.hostEpoch, 'replacement-host');
    assert.equal(recovered?.revision, 2);
  });

  it('returns the canonical terminal record when the card is answered during publication', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    const gateway = new FakeConversationReturnGateway();
    const updates: RuntimeInteractionRecord[] = [];
    let service!: ConversationService;
    service = new RuntimeInteractionService({
      store,
      hostEpoch: 'host-1',
      now: () => 2_000,
      cardPublisher: {
        prepare: async () => cardRef,
        publish: async () => {
          const pending = await store.get('conversation-1');
          assert.equal(pending?.status, 'pending');
          await service.respond({
            interactionId: 'conversation-1',
            ownerUserId: 'user-1',
            cardRef,
            expectedRevision: pending.revision,
            operationId: 'answer-during-publication',
            response: { kind: 'selection', selectedIds: ['sunrise'] },
          });
        },
        isLive: async () => true,
      },
      conversationReturnGateway: gateway,
      onRecordUpdated: (record) => updates.push(record),
    }) as unknown as ConversationService;

    const created = await service.createConversationDecision(conversationRequest());
    assert.equal(created.status, 'answered');
    assert.equal(created.terminal?.operationId, 'answer-during-publication');
    assert.equal(updates.at(-1)?.status, 'answered');
    assert.equal(gateway.returns.length, 1);
  });

  it('keeps conversation decisions across host restart while invalidating provider waiters', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    const oldHarness = makeHarness({ store });
    await oldHarness.service.createConversationDecision(conversationRequest());

    const restarted = new RuntimeInteractionService({
      store,
      hostEpoch: 'host-2',
      now: () => 3_000,
      cardPublisher: {
        prepare: async () => cardRef,
        publish: async () => {},
        isLive: async () => true,
      },
    });
    await restarted.invalidateOrphansOnStartup();

    assert.equal((await store.get('conversation-1'))?.status, 'pending');
  });

  it('reminds only the exact requester about its pending decision without inferring an answer', async () => {
    const { service } = makeHarness();
    await service.createConversationDecision(conversationRequest());

    const prompt = await service.pendingConversationDecisionPrompt(
      'user-1',
      'thread-1',
      'codex-sol',
      'owner-answer-message',
    );
    assert.match(prompt, /interactionId=conversation-1/);
    assert.match(prompt, /不要从裸文字猜结论/);
    assert.match(prompt, /currentOwnerMessageId=owner-answer-message/);
    assert.equal(await service.pendingConversationDecisionPrompt('user-1', 'thread-1', 'opus'), '');
    assert.equal(await service.pendingConversationDecisionPrompt('user-1', 'thread-other', 'codex-sol'), '');
  });

  it('uses expected revision plus operation id so two tabs produce one response message and one terminal', async () => {
    const { service, gateway } = makeHarness();
    const pending = await service.createConversationDecision(conversationRequest());

    const responses = await Promise.allSettled([
      service.respond({
        interactionId: 'conversation-1',
        ownerUserId: 'user-1',
        cardRef,
        expectedRevision: pending.revision,
        operationId: 'tab-a',
        response: { kind: 'selection', selectedIds: ['sunrise'] },
      }),
      service.respond({
        interactionId: 'conversation-1',
        ownerUserId: 'user-1',
        cardRef,
        expectedRevision: pending.revision,
        operationId: 'tab-b',
        response: { kind: 'selection', selectedIds: ['moonrise'] },
      }),
    ]);

    assert.equal(responses.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(responses.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(gateway.returns.length, 1);
    assert.equal(
      (responses.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<RuntimeInteractionRecord>)
        .value.status,
      'answered',
    );
  });

  it('recovers an append acknowledgement loss without appending a second response', async () => {
    const { service, gateway, store } = makeHarness();
    const pending = await service.createConversationDecision(conversationRequest());
    gateway.failAfterAppend = true;

    await assert.rejects(
      service.respond({
        interactionId: 'conversation-1',
        ownerUserId: 'user-1',
        cardRef,
        expectedRevision: pending.revision,
        operationId: 'recoverable-operation',
        response: { kind: 'selection', selectedIds: ['sunrise'] },
      }),
      (error: unknown) => error instanceof RuntimeInteractionError && error.code === 'unavailable',
    );
    assert.equal((await store.get('conversation-1'))?.submission?.operationId, 'recoverable-operation');

    const recovered = await service.recoverConversationSubmissions();
    assert.equal(recovered[0]?.status, 'answered');
    assert.equal(gateway.returns.length, 1);
  });

  it('recovers a claimed submission after a crash before message append', async () => {
    const { service, gateway, store } = makeHarness();
    const pending = await service.createConversationDecision(conversationRequest());
    gateway.failBeforeAppend = true;

    await assert.rejects(
      service.respond({
        interactionId: 'conversation-1',
        ownerUserId: 'user-1',
        cardRef,
        expectedRevision: pending.revision,
        operationId: 'claim-only-operation',
        response: { kind: 'selection', selectedIds: ['sunrise'] },
      }),
      (error: unknown) => error instanceof RuntimeInteractionError && error.code === 'unavailable',
    );
    assert.equal((await store.get('conversation-1'))?.submission?.operationId, 'claim-only-operation');
    assert.equal(gateway.returns.length, 0);

    const [recovered] = await service.recoverConversationSubmissions();
    assert.equal(recovered?.status, 'answered');
    assert.equal(gateway.returns.length, 1);
  });

  it('finishes the durable return after the winning claim even if the card changes before recovery', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    const gateway = new FakeConversationReturnGateway();
    let live = true;
    const service = new RuntimeInteractionService({
      store,
      hostEpoch: 'host-1',
      now: () => 2_000,
      cardPublisher: {
        prepare: async () => cardRef,
        publish: async () => {},
        isLive: async () => live,
      },
      conversationReturnGateway: gateway,
    }) as unknown as ConversationService;
    const pending = await service.createConversationDecision(conversationRequest());
    gateway.failBeforeAppend = true;

    await assert.rejects(
      service.respond({
        interactionId: 'conversation-1',
        ownerUserId: 'user-1',
        cardRef,
        expectedRevision: pending.revision,
        operationId: 'claimed-before-card-change',
        response: { kind: 'selection', selectedIds: ['sunrise'] },
      }),
      (error: unknown) => error instanceof RuntimeInteractionError && error.code === 'unavailable',
    );
    assert.equal((await store.get('conversation-1'))?.submission?.operationId, 'claimed-before-card-change');

    live = false;
    const [recovered] = await service.recoverConversationSubmissions();

    assert.equal(recovered?.status, 'answered');
    assert.equal(recovered?.terminal?.reasonCode, 'answered');
    assert.equal(gateway.returns.length, 1);
  });

  it('does not erase a claimed answer when a producer replay cannot rebroadcast the card', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    const gateway = new FakeConversationReturnGateway();
    let failPublish = false;
    const service = new RuntimeInteractionService({
      store,
      hostEpoch: 'host-1',
      now: () => 2_000,
      cardPublisher: {
        prepare: async () => cardRef,
        publish: async () => {
          if (failPublish) throw new Error('simulated rebroadcast failure');
        },
        isLive: async () => true,
      },
      conversationReturnGateway: gateway,
    }) as unknown as ConversationService;
    const pending = await service.createConversationDecision(conversationRequest());
    gateway.failBeforeAppend = true;
    await assert.rejects(
      service.respond({
        interactionId: 'conversation-1',
        ownerUserId: 'user-1',
        cardRef,
        expectedRevision: pending.revision,
        operationId: 'preserved-answer',
        response: { kind: 'selection', selectedIds: ['sunrise'] },
      }),
    );
    failPublish = true;
    await assert.rejects(service.createConversationDecision(conversationRequest()), /rebroadcast failure/);
    const preserved = await store.get('conversation-1');
    assert.equal(preserved?.status, 'pending');
    assert.equal(preserved?.submission?.operationId, 'preserved-answer');
  });

  it('recovers after the response message exists but terminal commit crashed', async () => {
    const store = new FailOnceOnCompleteStore();
    const { service, gateway } = makeHarness({ store });
    const pending = await service.createConversationDecision(conversationRequest());

    await assert.rejects(
      service.respond({
        interactionId: 'conversation-1',
        ownerUserId: 'user-1',
        cardRef,
        expectedRevision: pending.revision,
        operationId: 'settle-crash-operation',
        response: { kind: 'selection', selectedIds: ['moonrise'] },
      }),
      /terminal commit/,
    );
    assert.equal(gateway.returns.length, 1);
    assert.equal((await store.get('conversation-1'))?.status, 'pending');

    const [recovered] = await service.recoverConversationSubmissions();
    assert.equal(recovered?.status, 'answered');
    assert.equal(gateway.returns.length, 1, 'the same operation reuses its response message');
  });

  it('keeps free text out of the terminal record after delivery', async () => {
    const { service, store, gateway } = makeHarness();
    const pending = await service.createConversationDecision(conversationRequest());
    const settled = await service.respond({
      interactionId: 'conversation-1',
      ownerUserId: 'user-1',
      cardRef,
      expectedRevision: pending.revision,
      operationId: 'text-operation',
      response: { kind: 'text', text: 'The private launch phrase' },
    });

    assert.equal(gateway.returns[0]?.content, 'The private launch phrase');
    assert.equal(settled.terminal?.response?.kind, 'text');
    assert.equal(settled.submission, undefined);
    assert.doesNotMatch(JSON.stringify(await store.get('conversation-1')), /private launch phrase/i);
  });

  it('settles only a later owner-authored message from the canonical thread', async () => {
    const { service, gateway, store } = makeHarness();
    const pending = await service.createConversationDecision(conversationRequest());
    gateway.sourceMessages.set('valid-answer', {
      userId: 'user-1',
      threadId: 'thread-1',
      from: { kind: 'user', userId: 'user-1' },
      timestamp: 1_500,
    });
    gateway.sourceMessages.set('foreign-answer', {
      userId: 'user-2',
      threadId: 'thread-1',
      from: { kind: 'user', userId: 'user-1' },
      ownerAuthProvenance: 'strict',
      timestamp: 1_500,
    });
    gateway.sourceMessages.set('host-answer', {
      userId: 'user-1',
      threadId: 'thread-1',
      from: { kind: 'system', service: 'runtime-interaction' },
      ownerAuthProvenance: 'unknown',
      timestamp: 1_500,
    });
    gateway.sourceMessages.set('cat-answer', {
      userId: 'user-1',
      threadId: 'thread-1',
      from: { kind: 'agent', catId: 'codex-sol' },
      timestamp: 1_500,
    });
    gateway.sourceMessages.set('cross-thread-answer', {
      userId: 'user-1',
      threadId: 'thread-2',
      from: { kind: 'user', userId: 'user-1' },
      timestamp: 1_500,
    });
    gateway.sourceMessages.set('deleted-answer', {
      userId: 'user-1',
      threadId: 'thread-1',
      from: { kind: 'user', userId: 'user-1' },
      timestamp: 1_500,
      deletedAt: 1_501,
    });
    gateway.sourceMessages.set('tombstone-answer', {
      userId: 'user-1',
      threadId: 'thread-1',
      from: { kind: 'user', userId: 'user-1' },
      timestamp: 1_500,
      tombstone: true,
    });
    gateway.sourceMessages.set('pre-publication-answer', {
      userId: 'user-1',
      threadId: 'thread-1',
      from: { kind: 'user', userId: 'user-1' },
      timestamp: 1_000,
    });

    gateway.sourceMessages.set('wrong-canonical-owner', {
      userId: 'user-1',
      threadId: 'thread-1',
      from: { kind: 'user', userId: 'user-2' },
      timestamp: 1500,
    });
    for (const responseMessageId of [
      'wrong-canonical-owner',
      'missing-answer',
      'foreign-answer',
      'host-answer',
      'cat-answer',
      'cross-thread-answer',
      'deleted-answer',
      'tombstone-answer',
      'pre-publication-answer',
    ]) {
      await assert.rejects(
        service.settleFromOwnerMessage({
          interactionId: 'conversation-1',
          requester,
          ownerMessageAuth: {
            ownerAuthProvenance: 'strict',
            originTriggerMessageId: responseMessageId,
          },
          expectedRevision: pending.revision,
          operationId: `invalid:${responseMessageId}`,
          responseMessageId,
        }),
        (error: unknown) => error instanceof RuntimeInteractionError && error.code === 'unauthorized',
      );
    }
    const settled = await service.settleFromOwnerMessage({
      interactionId: 'conversation-1',
      requester,
      ownerMessageAuth: { ownerAuthProvenance: 'strict', originTriggerMessageId: 'valid-answer' },
      expectedRevision: pending.revision,
      operationId: 'valid',
      responseMessageId: 'valid-answer',
    });
    assert.equal(settled.status, 'answered');
    assert.equal(settled.terminal?.responseMessageId, 'valid-answer');
    assert.equal((await store.get('conversation-1'))?.status, 'answered');
    assert.equal(gateway.returns.length, 0, 'referenced owner text must not append a duplicate turn');
  });

  it('uses the referenced owner-message time when enforcing a deadline', async () => {
    const { service, gateway, store } = makeHarness({ now: () => 2_000 });
    const beforeDeadline = await service.createConversationDecision({
      ...conversationRequest('before-deadline'),
      deadlineAt: 1_800,
    } as RuntimeInteractionRequest);
    gateway.sourceMessages.set('answer-at-1700', {
      userId: 'user-1',
      threadId: 'thread-1',
      from: { kind: 'user', userId: 'user-1' },
      ownerAuthProvenance: 'strict',
      timestamp: 1_700,
    });
    const answered = await service.settleFromOwnerMessage({
      interactionId: 'before-deadline',
      requester,
      ownerMessageAuth: { ownerAuthProvenance: 'strict', originTriggerMessageId: 'answer-at-1700' },
      expectedRevision: beforeDeadline.revision,
      operationId: 'reference-before-deadline',
      responseMessageId: 'answer-at-1700',
    });
    assert.equal(answered.status, 'answered');

    const afterDeadline = await service.createConversationDecision({
      ...conversationRequest('after-deadline'),
      deadlineAt: 1_800,
    } as RuntimeInteractionRequest);
    gateway.sourceMessages.set('answer-at-1900', {
      userId: 'user-1',
      threadId: 'thread-1',
      from: { kind: 'user', userId: 'user-1' },
      ownerAuthProvenance: 'strict',
      timestamp: 1_900,
    });
    await assert.rejects(
      service.settleFromOwnerMessage({
        interactionId: 'after-deadline',
        requester,
        ownerMessageAuth: { ownerAuthProvenance: 'strict', originTriggerMessageId: 'answer-at-1900' },
        expectedRevision: afterDeadline.revision,
        operationId: 'reference-after-deadline',
        responseMessageId: 'answer-at-1900',
      }),
      (error: unknown) => error instanceof RuntimeInteractionError && error.code === 'stale',
    );
    assert.equal((await store.get('after-deadline'))?.terminal?.reasonCode, 'expired');
    assert.equal(gateway.returns.at(-1)?.author, 'host');
  });

  it('linearizes an at-deadline click behind the declared Host default', async () => {
    let now = 1_000;
    const { service, gateway } = makeHarness({ now: () => now });
    const request = {
      ...conversationRequest(),
      deadlineAt: 1_500,
      defaultResponse: { kind: 'selection', selectedIds: ['sunrise'] },
    } as RuntimeInteractionRequest;
    const pending = await service.createConversationDecision(request);
    now = 1_500;

    await Promise.allSettled([
      service.respond({
        interactionId: 'conversation-1',
        ownerUserId: 'user-1',
        cardRef,
        expectedRevision: pending.revision,
        operationId: 'late-click',
        response: { kind: 'selection', selectedIds: ['moonrise'] },
      }),
      service.reconcileConversationDeadlines(),
    ]);

    assert.equal(gateway.returns.length, 1);
    assert.equal(gateway.returns[0]?.author, 'host');
    assert.match(gateway.returns[0]?.content ?? '', /按默认/);
  });

  it('expires without a default through one Host-authored return', async () => {
    let now = 1_000;
    const { service, gateway } = makeHarness({ now: () => now });
    await service.createConversationDecision({
      ...conversationRequest(),
      deadlineAt: 1_500,
    } as RuntimeInteractionRequest);
    now = 1_500;

    const [expired] = await service.reconcileConversationDeadlines();
    assert.equal(expired?.terminal?.reasonCode, 'expired');
    assert.equal(gateway.returns.length, 1);
    assert.equal(gateway.returns[0]?.author, 'host');
    assert.match(gateway.returns[0]?.content ?? '', /截止/);
  });

  it('rejects a foreign owner, wrong card, and deleted canonical presentation', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    const gateway = new FakeConversationReturnGateway();
    let live = true;
    const service = new RuntimeInteractionService({
      store,
      hostEpoch: 'host-1',
      now: () => 2_000,
      cardPublisher: {
        prepare: async () => cardRef,
        publish: async () => {},
        isLive: async () => live,
      },
      conversationReturnGateway: gateway,
    }) as unknown as ConversationService;
    const pending = await service.createConversationDecision(conversationRequest());
    const response = {
      interactionId: 'conversation-1',
      cardRef,
      expectedRevision: pending.revision,
      operationId: 'invalid-surface',
      response: { kind: 'selection', selectedIds: ['sunrise'] },
    };
    await assert.rejects(service.respond({ ...response, ownerUserId: 'user-2' }), /not owned/i);
    await assert.rejects(
      service.respond({ ...response, ownerUserId: 'user-1', cardRef: { ...cardRef, messageId: 'wrong' } }),
      /not owned/i,
    );
    live = false;
    await assert.rejects(
      service.respond({ ...response, ownerUserId: 'user-1' }),
      (error: unknown) => error instanceof RuntimeInteractionError && error.reasonCode === 'confirmation_unavailable',
    );
    assert.equal(gateway.returns.length, 0);
    assert.equal((await store.get('conversation-1'))?.terminal?.reasonCode, 'confirmation_unavailable');
  });

  it('supports requester-authenticated withdraw and supersede through the same revision CAS', async () => {
    const { service } = makeHarness();
    const withdrawnPending = await service.createConversationDecision(conversationRequest('withdrawn'));
    const withdrawn = await service.withdrawConversationDecision({
      interactionId: 'withdrawn',
      requester,
      expectedRevision: withdrawnPending.revision,
      operationId: 'withdraw-operation',
    });
    assert.equal(withdrawn.terminal?.reasonCode, 'withdrawn');

    const oldPending = await service.createConversationDecision(conversationRequest('old-question'));
    await service.createConversationDecision({
      ...conversationRequest('new-question'),
      createdAt: 1_001,
    } as RuntimeInteractionRequest);
    const superseded = await service.supersedeConversationDecision({
      interactionId: 'old-question',
      requester,
      expectedRevision: oldPending.revision,
      operationId: 'supersede-operation',
      replacementInteractionId: 'new-question',
    });
    assert.equal(superseded.terminal?.reasonCode, 'superseded');
    assert.equal(superseded.terminal?.supersededByInteractionId, 'new-question');
  });
});
