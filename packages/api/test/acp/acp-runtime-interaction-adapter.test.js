/**
 * F306 Phase C — iCode `_chrys/request_input` → provider-neutral Runtime Interaction.
 *
 * The bridge maps an iCode ask-user batch onto the shared question interaction
 * (canonical card in-thread), then maps the human's answers back onto iCode's
 * strict positional wire shape: [{ values: string[], note: string }] and the
 * cancelled outcome. Malformed batches must fail loudly (iCode validates
 * strictly and degrades to Cancelled only for well-formed cancellations).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { createAcpRequestInputBridge, MAX_REQUEST_INPUT_QUESTIONS, MAX_REQUEST_INPUT_OPTIONS } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/icode/runtime-interaction-adapter.js'
);
const { RuntimeInteractionError, RuntimeInteractionService } = await import(
  '../../dist/domains/runtime-interaction/RuntimeInteractionService.js'
);
const { InMemoryRuntimeInteractionStore } = await import(
  '../../dist/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js'
);

const OWNER = { userId: 'user-1', threadId: 'thread-1', catId: 'opus', invocationId: 'inv-1' };

function makeContext(port, overrides = {}) {
  return {
    owner: OWNER,
    port,
    providerSessionId: 'sess-1',
    createInteractionId: () => 'ix-fixed',
    ...overrides,
  };
}

function makePort(responder) {
  const calls = [];
  return {
    calls,
    async request(request, options) {
      calls.push({ request, options });
      return responder(request);
    },
  };
}

const BATCH = {
  sessionId: 'sess-1',
  questions: [
    {
      header: 'Choice',
      question: 'Pick some',
      options: [{ label: 'A', description: 'alpha' }, { label: 'B' }],
      multiSelect: true,
    },
    { question: 'Anything else?' },
  ],
};

describe('acp request_input bridge', () => {
  it('maps an iCode ask-user batch onto a canonical question interaction', async () => {
    const port = makePort(() => ({ kind: 'answers', answers: { q0: ['A', 'B'], q1: [] } }));
    const bridge = createAcpRequestInputBridge(makeContext(port));

    const result = await bridge.handle({ id: 'ask-1', params: BATCH });

    assert.equal(port.calls.length, 1);
    const request = port.calls[0].request;
    assert.equal(request.version, 1);
    assert.equal(request.kind, 'question');
    assert.equal(request.interactionId, 'ix-fixed');
    assert.equal(request.title, 'iCode 需要你的回答');
    assert.deepEqual(request.owner, OWNER);
    assert.equal(request.provider.providerId, 'chrys');
    assert.equal(request.provider.method, '_chrys/request_input');
    assert.equal(request.provider.requestId, 'ask-1');
    assert.equal(request.provider.threadId, 'sess-1');

    assert.equal(request.questions.length, 2);
    assert.deepEqual(request.questions[0], {
      id: 'q0',
      header: 'Choice',
      question: 'Pick some',
      multiSelect: true,
      isOther: true,
      allowUnanswered: true,
      options: [{ label: 'A', description: 'alpha' }, { label: 'B' }],
    });
    // iCode omits header for this question — fall back to the question text so
    // the canonical card still renders a non-blank title. A question without
    // options answers through the main free-text input, so it must not set
    // isOther (that would render a second box and split the value).
    assert.deepEqual(request.questions[1], {
      id: 'q1',
      header: 'Anything else?',
      question: 'Anything else?',
      allowUnanswered: true,
    });

    assert.deepEqual(result, {
      cancelled: false,
      answers: [
        { values: ['A', 'B'], note: '' },
        { values: [], note: '' },
      ],
    });
    assert.equal(bridge.hasPending(), false);
  });

  it('maps a human skip (user_rejected) onto the iCode cancelled outcome', async () => {
    const port = makePort(() => {
      throw new RuntimeInteractionError('stale', 'user_rejected', 'user_rejected');
    });
    const bridge = createAcpRequestInputBridge(makeContext(port));

    const result = await bridge.handle({ id: 'ask-2', params: BATCH });

    assert.deepEqual(result, { cancelled: true });
    assert.equal(bridge.hasPending(), false);
  });

  it('maps an aborted turn (provider_cancelled) onto the iCode cancelled outcome', async () => {
    const port = makePort(() => {
      throw new RuntimeInteractionError('unavailable', 'provider_cancelled', 'provider_cancelled');
    });
    const bridge = createAcpRequestInputBridge(makeContext(port));

    assert.deepEqual(await bridge.handle({ id: 'ask-3', params: BATCH }), { cancelled: true });
  });

  it('maps lifecycle withdrawal/expiry onto the iCode cancelled outcome', async () => {
    for (const reasonCode of ['withdrawn', 'superseded', 'expired']) {
      const port = makePort(() => {
        throw new RuntimeInteractionError('stale', reasonCode, reasonCode);
      });
      const bridge = createAcpRequestInputBridge(makeContext(port));
      assert.deepEqual(await bridge.handle({ id: `ask-${reasonCode}`, params: BATCH }), { cancelled: true });
    }
  });

  it('keeps host/transport/confirmation failures as errors', async () => {
    for (const reasonCode of ['confirmation_unavailable', 'transport_lost', 'host_restarted']) {
      const error = new RuntimeInteractionError('stale', reasonCode, reasonCode);
      const port = makePort(() => {
        throw error;
      });
      const bridge = createAcpRequestInputBridge(makeContext(port));
      await assert.rejects(
        () => bridge.handle({ id: `ask-${reasonCode}`, params: BATCH }),
        (thrown) => thrown === error,
        `${reasonCode} must surface to iCode as an error`,
      );
    }
  });

  it('surfaces a removed-card confirmation failure from the real service as an error', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    let cardIsLive = true;
    const service = new RuntimeInteractionService({
      store,
      hostEpoch: 'host-epoch-1',
      now: () => 1_777_000_000_100,
      cardPublisher: {
        prepare: async (request) => ({
          threadId: 'thread-1',
          messageId: 'message-1',
          blockId: `runtime-interaction:${request.interactionId}`,
        }),
        publish: async () => {},
        isLive: async () => cardIsLive,
      },
    });
    const bridge = createAcpRequestInputBridge({
      owner: OWNER,
      port: service,
      providerSessionId: 'sess-1',
      createInteractionId: () => 'ix-confirm',
    });
    const settled = bridge.handle({ id: 'ask-confirm', params: BATCH }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );

    let pending;
    for (let index = 0; index < 30; index += 1) {
      pending = await store.get('ix-confirm');
      if (pending?.status === 'pending') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(pending?.status, 'pending');
    assert.ok(pending.cardRef, 'the pending interaction must have a canonical card');

    cardIsLive = false;
    await assert.rejects(
      service.respond({
        interactionId: 'ix-confirm',
        ownerUserId: 'user-1',
        cardRef: pending.cardRef,
        response: { kind: 'answers', answers: { q0: ['A'], q1: [] } },
      }),
      (error) => error instanceof RuntimeInteractionError && error.reasonCode === 'confirmation_unavailable',
    );

    const outcome = await settled;
    assert.equal(outcome.ok, false, 'the human answer must not become a fabricated skip');
    assert.equal(outcome.error.reasonCode, 'confirmation_unavailable');
    assert.equal((await store.get('ix-confirm'))?.terminal?.reasonCode, 'confirmation_unavailable');
  });

  it('rethrows infrastructure failures instead of fabricating a human cancel', async () => {
    for (const error of [
      new RuntimeInteractionError('unavailable', 'surface publication failed', 'surface_publication_failed'),
      new RuntimeInteractionError('unavailable', 'confirmation check unavailable'),
      new RuntimeInteractionError('not_found', 'runtime interaction not found'),
    ]) {
      const port = makePort(() => {
        throw error;
      });
      const bridge = createAcpRequestInputBridge(makeContext(port));
      await assert.rejects(
        () => bridge.handle({ id: 'ask-infra', params: BATCH }),
        (thrown) => thrown === error,
        'infrastructure failures must surface to iCode as errors',
      );
    }
  });

  it('reports pending interactions while the human is deciding', async () => {
    let release;
    const port = makePort(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ kind: 'answers', answers: { q0: ['A'], q1: [] } });
        }),
    );
    const bridge = createAcpRequestInputBridge(makeContext(port));

    const pending = bridge.handle({ id: 'ask-4', params: BATCH });
    await Promise.resolve();
    assert.equal(bridge.hasPending(), true);
    release();
    await pending;
    assert.equal(bridge.hasPending(), false);
  });

  it('rejects malformed batches so iCode sees a protocol error instead of a silent cancel', async () => {
    const port = makePort(() => ({ kind: 'answers', answers: {} }));
    const bridge = createAcpRequestInputBridge(makeContext(port));

    await assert.rejects(() => bridge.handle({ id: 'ask-5', params: { questions: [] } }), /questions/i);
    await assert.rejects(() => bridge.handle({ id: 'ask-6', params: {} }), /questions/i);
    await assert.rejects(
      () =>
        bridge.handle({
          id: 'ask-7',
          params: {
            questions: Array.from({ length: MAX_REQUEST_INPUT_QUESTIONS + 1 }, (_, i) => ({ question: `Q${i}` })),
          },
        }),
      /too many|questions/i,
    );
    await assert.rejects(
      () =>
        bridge.handle({
          id: 'ask-8',
          params: {
            questions: [
              {
                question: 'Q',
                options: Array.from({ length: MAX_REQUEST_INPUT_OPTIONS + 1 }, (_, i) => ({ label: `L${i}` })),
              },
            ],
          },
        }),
      /options/i,
    );
    await assert.rejects(
      () => bridge.handle({ id: 'ask-9', params: { questions: [{ question: '   ' }] } }),
      /question/i,
    );
    await assert.rejects(
      () => bridge.handle({ id: 'ask-10', params: { questions: [{ question: 'Q', multiSelect: 'yes' }] } }),
      /multiSelect/i,
    );
    assert.equal(port.calls.length, 0, 'malformed batches must never reach the interaction port');
  });
});
