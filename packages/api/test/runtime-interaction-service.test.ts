import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeInteractionCardRef, RuntimeInteractionRecord, RuntimeInteractionRequest } from '@cat-cafe/shared';
import {
  RuntimeInteractionError,
  RuntimeInteractionService,
} from '../src/domains/runtime-interaction/RuntimeInteractionService.js';
import { InMemoryRuntimeInteractionStore } from '../src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';

const cardRef: RuntimeInteractionCardRef = {
  threadId: 'thread-1',
  messageId: 'message-1',
  blockId: 'runtime-interaction:interaction-1',
};

function approvalRequest(interactionId = 'interaction-1'): RuntimeInteractionRequest {
  return {
    version: 1,
    interactionId,
    kind: 'approval',
    owner: { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', invocationId: 'inv-1' },
    provider: {
      providerId: 'openai',
      method: 'item/commandExecution/requestApproval',
      requestId: `rpc-${interactionId}`,
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'provider-item',
    },
    createdAt: 1_777_000_000_000,
    title: 'Run command?',
    description: 'pnpm test',
    decisions: [
      { id: 'accept', label: 'Allow once', outcome: 'accept' },
      { id: 'decline', label: 'Decline', outcome: 'decline' },
      { id: 'cancel', label: 'Cancel', outcome: 'cancel' },
    ],
  };
}

function questionRequest(interactionId = 'interaction-secret'): RuntimeInteractionRequest {
  return {
    version: 1,
    interactionId,
    kind: 'question',
    owner: { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', invocationId: 'inv-secret' },
    provider: {
      providerId: 'openai',
      method: 'item/tool/requestUserInput',
      requestId: `rpc-${interactionId}`,
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'provider-item',
    },
    createdAt: 1_777_000_000_001,
    title: 'Need answers',
    questions: [
      { id: 'environment', header: 'Environment', question: 'Where?' },
      { id: 'token', header: 'Token', question: 'Token?', isSecret: true },
    ],
  };
}

function makeHarness(input?: {
  publish?: (request: RuntimeInteractionRequest) => Promise<RuntimeInteractionCardRef>;
  isLive?: (request: RuntimeInteractionRequest, cardRef: RuntimeInteractionCardRef) => Promise<boolean>;
  store?: InMemoryRuntimeInteractionStore;
  hostEpoch?: string;
}) {
  const store = input?.store ?? new InMemoryRuntimeInteractionStore();
  const published: string[] = [];
  const updated: RuntimeInteractionRecord[] = [];
  const service = new RuntimeInteractionService({
    store,
    hostEpoch: input?.hostEpoch ?? 'host-epoch-1',
    now: () => 1_777_000_000_100,
    cardPublisher: {
      publish:
        input?.publish ??
        (async (request) => {
          published.push(request.interactionId);
          return { ...cardRef, blockId: `runtime-interaction:${request.interactionId}` };
        }),
      isLive: input?.isLive ?? (async () => true),
    },
    onRecordUpdated: (record) => updated.push(record),
  });
  return { store, service, published, updated };
}

async function waitForStatus(
  store: InMemoryRuntimeInteractionStore,
  interactionId: string,
  status: RuntimeInteractionRecord['status'],
): Promise<RuntimeInteractionRecord> {
  for (let index = 0; index < 30; index += 1) {
    const record = await store.get(interactionId);
    if (record?.status === status) return record;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`interaction ${interactionId} did not reach ${status}`);
}

describe('RuntimeInteractionService', () => {
  it('publishes one anchored pending record and resolves only after the durable terminal CAS', async () => {
    const { service, store, published } = makeHarness();
    let statusWhenResolved: RuntimeInteractionRecord['status'] | undefined;
    const responsePromise = service.request(approvalRequest()).then(async (response) => {
      statusWhenResolved = (await store.get('interaction-1'))?.status;
      return response;
    });

    const pending = await waitForStatus(store, 'interaction-1', 'pending');
    assert.deepEqual(published, ['interaction-1']);
    assert.deepEqual(pending.cardRef, cardRef);

    const terminal = await service.respond({
      interactionId: 'interaction-1',
      ownerUserId: 'user-1',
      cardRef,
      response: { kind: 'decision', decisionId: 'accept' },
    });
    assert.equal(terminal.status, 'answered');
    assert.deepEqual(await responsePromise, { kind: 'decision', decisionId: 'accept' });
    assert.equal(statusWhenResolved, 'answered', 'durable CAS must happen before provider waiter resolution');
  });

  it('allows exactly one concurrent answer and never replays a terminal response', async () => {
    const { service, store } = makeHarness();
    const responsePromise = service.request(approvalRequest());
    await waitForStatus(store, 'interaction-1', 'pending');

    const [first, second] = await Promise.allSettled([
      service.respond({
        interactionId: 'interaction-1',
        ownerUserId: 'user-1',
        cardRef,
        response: { kind: 'decision', decisionId: 'accept' },
      }),
      service.respond({
        interactionId: 'interaction-1',
        ownerUserId: 'user-1',
        cardRef,
        response: { kind: 'decision', decisionId: 'decline' },
      }),
    ]);
    assert.equal([first, second].filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal([first, second].filter((result) => result.status === 'rejected').length, 1);
    await responsePromise;
    await assert.rejects(
      service.respond({
        interactionId: 'interaction-1',
        ownerUserId: 'user-1',
        cardRef,
        response: { kind: 'decision', decisionId: 'accept' },
      }),
      (error: unknown) => error instanceof RuntimeInteractionError && error.code === 'stale',
    );
  });

  it('does not persist secret or ordinary answer values', async () => {
    const { service, store } = makeHarness();
    const responsePromise = service.request(questionRequest());
    const pending = await waitForStatus(store, 'interaction-secret', 'pending');
    if (!pending.cardRef) throw new Error('expected pending interaction to have a card reference');
    const secretCardRef = pending.cardRef;

    await service.respond({
      interactionId: 'interaction-secret',
      ownerUserId: 'user-1',
      cardRef: secretCardRef,
      response: {
        kind: 'answers',
        answers: { environment: ['Alpha'], token: ['super-secret-value'] },
      },
    });
    const providerResponse = await responsePromise;
    assert.equal(providerResponse.kind, 'answers');
    const stored = await store.get('interaction-secret');
    assert.equal(stored?.status, 'answered');
    assert.doesNotMatch(JSON.stringify(stored), /Alpha|super-secret-value/);
    assert.deepEqual(stored?.terminal?.response, {
      kind: 'answers',
      answeredQuestionIds: ['environment', 'token'],
      secretQuestionIds: ['token'],
    });
  });

  it('rejects cross-owner and copied-card responses without mutating pending truth', async () => {
    const { service, store } = makeHarness();
    const responsePromise = service.request(approvalRequest());
    await waitForStatus(store, 'interaction-1', 'pending');

    await assert.rejects(
      service.respond({
        interactionId: 'interaction-1',
        ownerUserId: 'user-2',
        cardRef,
        response: { kind: 'decision', decisionId: 'accept' },
      }),
      (error: unknown) => error instanceof RuntimeInteractionError && error.code === 'unauthorized',
    );
    await assert.rejects(
      service.respond({
        interactionId: 'interaction-1',
        ownerUserId: 'user-1',
        cardRef: { ...cardRef, messageId: 'copied-message' },
        response: { kind: 'decision', decisionId: 'accept' },
      }),
      (error: unknown) => error instanceof RuntimeInteractionError && error.code === 'unauthorized',
    );
    assert.equal((await store.get('interaction-1'))?.status, 'pending');

    await service.invalidateInvocation('inv-1', 'provider_cancelled');
    await assert.rejects(responsePromise, /provider_cancelled/);
  });

  it('invalidates transport loss and rejects the active waiter without replay', async () => {
    const { service, store } = makeHarness();
    const responsePromise = service.request(approvalRequest());
    await waitForStatus(store, 'interaction-1', 'pending');

    await service.invalidateInvocation('inv-1', 'transport_lost');
    await assert.rejects(responsePromise, /transport_lost/);
    const record = await store.get('interaction-1');
    assert.equal(record?.status, 'invalidated');
    assert.equal(record?.terminal?.reasonCode, 'transport_lost');
  });

  it('preserves provider cancellation provenance from an invocation-bound abort signal', async () => {
    const { service, store } = makeHarness();
    const controller = new AbortController();
    const responsePromise = service.request(approvalRequest(), { signal: controller.signal });
    await waitForStatus(store, 'interaction-1', 'pending');

    controller.abort('provider_cancelled');
    await assert.rejects(responsePromise, /provider_cancelled/);
    assert.equal((await store.get('interaction-1'))?.terminal?.reasonCode, 'provider_cancelled');
  });

  it('preserves provider cancellation when the invocation closes during card publication', async () => {
    let finishPublication: ((value: RuntimeInteractionCardRef) => void) | undefined;
    const { service, store } = makeHarness({
      publish: async () =>
        new Promise<RuntimeInteractionCardRef>((resolve) => {
          finishPublication = resolve;
        }),
    });
    const controller = new AbortController();
    const responsePromise = service.request(approvalRequest(), { signal: controller.signal });
    await waitForStatus(store, 'interaction-1', 'staged');

    controller.abort('provider_cancelled');
    finishPublication?.(cardRef);

    await assert.rejects(responsePromise, /provider_cancelled/);
    assert.equal((await store.get('interaction-1'))?.terminal?.reasonCode, 'provider_cancelled');
  });

  it('invalidates staged/pending records from an earlier host epoch on startup', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    const oldHarness = makeHarness({ store, hostEpoch: 'old-host' });
    const oldResponse = oldHarness.service.request(approvalRequest('old-interaction'));
    void oldResponse.catch(() => {});
    await waitForStatus(store, 'old-interaction', 'pending');

    const restarted = makeHarness({ store, hostEpoch: 'new-host' });
    const invalidated = await restarted.service.invalidateOrphansOnStartup();
    assert.deepEqual(
      invalidated.map((record) => record.request.interactionId),
      ['old-interaction'],
    );
    assert.equal((await store.get('old-interaction'))?.terminal?.reasonCode, 'host_restarted');
  });

  it('fails closed when a response reaches a process without the invocation-bound waiter', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    const owningProcess = makeHarness({ store, hostEpoch: 'single-writer-host' });
    const providerResponse = owningProcess.service.request(approvalRequest());
    void providerResponse.catch(() => {});
    await waitForStatus(store, 'interaction-1', 'pending');

    const wrongProcess = makeHarness({ store, hostEpoch: 'single-writer-host' });
    await assert.rejects(
      wrongProcess.service.respond({
        interactionId: 'interaction-1',
        ownerUserId: 'user-1',
        cardRef,
        response: { kind: 'decision', decisionId: 'accept' },
      }),
      (error: unknown) =>
        error instanceof RuntimeInteractionError && error.code === 'stale' && error.reasonCode === 'transport_lost',
    );
    assert.equal((await store.get('interaction-1'))?.terminal?.reasonCode, 'transport_lost');
  });

  it('invalidates instead of settling after the canonical card is removed', async () => {
    const { service, store } = makeHarness({ isLive: async () => false });
    const providerResponse = service.request(approvalRequest());
    void providerResponse.catch(() => {});
    await waitForStatus(store, 'interaction-1', 'pending');

    await assert.rejects(
      service.respond({
        interactionId: 'interaction-1',
        ownerUserId: 'user-1',
        cardRef,
        response: { kind: 'decision', decisionId: 'accept' },
      }),
      (error: unknown) =>
        error instanceof RuntimeInteractionError &&
        error.code === 'stale' &&
        error.reasonCode === 'confirmation_unavailable',
    );
    await assert.rejects(
      providerResponse,
      (error: unknown) => error instanceof RuntimeInteractionError && error.reasonCode === 'confirmation_unavailable',
    );
    assert.equal((await store.get('interaction-1'))?.terminal?.reasonCode, 'confirmation_unavailable');
  });

  it('keeps the request pending when canonical-card liveness cannot be checked transiently', async () => {
    const { service, store } = makeHarness({ isLive: async () => Promise.reject(new Error('message store busy')) });
    const providerResponse = service.request(approvalRequest());
    await waitForStatus(store, 'interaction-1', 'pending');
    await assert.rejects(
      service.respond({
        interactionId: 'interaction-1',
        ownerUserId: 'user-1',
        cardRef,
        response: { kind: 'decision', decisionId: 'accept' },
      }),
      (error: unknown) =>
        error instanceof RuntimeInteractionError && error.code === 'unavailable' && error.reasonCode === undefined,
    );
    assert.equal((await store.get('interaction-1'))?.status, 'pending');

    await service.invalidateInvocation('inv-1', 'provider_cancelled');
    await assert.rejects(providerResponse, /provider_cancelled/);
  });

  it('terminalizes publication failure and exposes no actionable record', async () => {
    const { service, store } = makeHarness({ publish: async () => Promise.reject(new Error('append failed')) });
    await assert.rejects(service.request(approvalRequest()), /surface_publication_failed/);
    const record = await store.get('interaction-1');
    assert.equal(record?.status, 'invalidated');
    assert.equal(record?.terminal?.reasonCode, 'surface_publication_failed');
    assert.equal(record?.cardRef, undefined);
  });
});
