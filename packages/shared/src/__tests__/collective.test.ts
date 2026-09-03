import { describe, expect, it } from 'vitest';

import {
  type CollectiveEventEnvelope,
  collectiveAckRequestSchema,
  collectiveClientAnchorSchema,
  collectiveEventEnvelopeSchema,
  collectivePairingBridgeMessageSchema,
  collectivePairingIntentSchema,
  collectivePairingMessageSchema,
} from '../types/collective.js';

const coordinates = {
  serviceInstanceId: 'svc_01J7WB6E2N3G8JQ1SM7X23D4Q5',
  collectiveId: 'col_01J7WB6E2N3G8JQ1SM7X23D4Q6',
};

function agentEvent(): CollectiveEventEnvelope {
  return {
    ...coordinates,
    eventId: 'evt_01J7WB6E2N3G8JQ1SM7X23D4Q7',
    clientEventId: 'client-message-1',
    sequence: 1,
    actor: {
      kind: 'agent',
      human: {
        humanId: 'human_01J7WB6E2N3G8JQ1SM7X23D4QB',
        displayName: 'You',
      },
      agent: {
        agentId: 'codex-sol',
        displayName: 'Sol',
      },
      provenance: {
        connectionId: 'con_01J7WB6E2N3G8JQ1SM7X23D4Q8',
        endpointId: 'ep_01J7WB6E2N3G8JQ1SM7X23D4Q9',
        endpointLabel: 'You 的 Clowder AI',
        catId: 'codex-sol',
        sessionRef: 'invocation:0001787917796865',
      },
    },
    target: { kind: 'channel', channelId: 'general' },
    body: 'The first real Collective signal.',
    acceptedAt: '2026-08-28T16:00:00.000Z',
  };
}

describe('Collective protocol', () => {
  it('accepts a coordinate-bearing event with verifiable Agent provenance', () => {
    expect(collectiveEventEnvelopeSchema.parse(agentEvent())).toEqual(agentEvent());
  });

  it('rejects caller-shaped extras and incomplete Agent provenance', () => {
    const event = agentEvent();
    expect(() => collectiveEventEnvelopeSchema.parse({ ...event, impersonateHumanId: 'human-owner' })).toThrow();

    const { sessionRef: _, ...incompleteProvenance } =
      event.actor.kind === 'agent' ? event.actor.provenance : neverReached();
    expect(() =>
      collectiveEventEnvelopeSchema.parse({
        ...event,
        actor: { ...event.actor, provenance: incompleteProvenance },
      }),
    ).toThrow();
  });

  it('keeps Human and Agent targets structurally distinct', () => {
    expect(
      collectiveEventEnvelopeSchema.parse({
        ...agentEvent(),
        target: { kind: 'human', humanId: 'human_01J7WB6E2N3G8JQ1SM7X23D4QB' },
      }).target,
    ).toEqual({ kind: 'human', humanId: 'human_01J7WB6E2N3G8JQ1SM7X23D4QB' });
    expect(
      collectiveEventEnvelopeSchema.parse({
        ...agentEvent(),
        target: {
          kind: 'agent',
          humanId: 'human_01J7WB6E2N3G8JQ1SM7X23D4QB',
          agentId: 'codex-sol',
        },
      }).target,
    ).toEqual({
      kind: 'agent',
      humanId: 'human_01J7WB6E2N3G8JQ1SM7X23D4QB',
      agentId: 'codex-sol',
    });
    expect(() =>
      collectiveEventEnvelopeSchema.parse({
        ...agentEvent(),
        target: { kind: 'actor', id: 'codex-sol' },
      }),
    ).toThrow();
  });

  it('requires positive ordered sequences and bounded monotonic ACK coordinates', () => {
    expect(() => collectiveEventEnvelopeSchema.parse({ ...agentEvent(), sequence: 0 })).toThrow();
    expect(
      collectiveAckRequestSchema.parse({
        ...coordinates,
        connectionId: 'con_01J7WB6E2N3G8JQ1SM7X23D4Q8',
        sequence: 1,
      }),
    ).toMatchObject({ sequence: 1 });
    expect(() =>
      collectiveAckRequestSchema.parse({
        ...coordinates,
        connectionId: 'con_01J7WB6E2N3G8JQ1SM7X23D4Q8',
        sequence: -1,
      }),
    ).toThrow();
  });

  it('binds pairing intents to stable coordinates, Host origin, nonce and expiry', () => {
    const intent = {
      ...coordinates,
      pairingIntentId: 'pair_01J7WB6E2N3G8JQ1SM7X23D4QA',
      hostOrigin: 'http://localhost:5172',
      nonce: 'nonce-with-at-least-16-characters',
      expiresAt: '2026-08-28T16:05:00.000Z',
    };
    expect(collectivePairingIntentSchema.parse(intent)).toEqual(intent);
    expect(() => collectivePairingIntentSchema.parse({ ...intent, hostOrigin: 'not-a-url' })).toThrow();
    expect(() => collectivePairingIntentSchema.parse({ ...intent, nonce: 'short' })).toThrow();
  });

  it('keeps the iframe pairing handshake typed and fail-closed', () => {
    expect(
      collectivePairingBridgeMessageSchema.parse({
        type: 'collective:pairing-ready',
        serviceUrl: 'http://localhost:5201',
      }),
    ).toEqual({ type: 'collective:pairing-ready', serviceUrl: 'http://localhost:5201' });
    expect(
      collectivePairingBridgeMessageSchema.parse({
        type: 'collective:pairing-error',
        serviceUrl: 'http://localhost:5201',
        code: 'session_required',
      }),
    ).toMatchObject({ code: 'session_required' });
    expect(() =>
      collectivePairingBridgeMessageSchema.parse({
        type: 'collective:pairing-error',
        serviceUrl: 'http://localhost:5201',
        code: 'steward_required',
      }),
    ).toThrow();
    expect(() =>
      collectivePairingBridgeMessageSchema.parse({
        type: 'collective:pairing-ready',
        serviceUrl: 'javascript:alert(1)',
      }),
    ).toThrow();
    expect(() =>
      collectivePairingMessageSchema.parse({
        type: 'collective:pairing-error',
        serviceUrl: 'http://localhost:5201',
        code: 'unknown_failure',
      }),
    ).toThrow();
  });

  it('exposes one stable canonical-client anchor for a future F307 host adapter', () => {
    const anchor = {
      kind: 'collective-client',
      ...coordinates,
      connectionId: 'con_01J7WB6E2N3G8JQ1SM7X23D4Q8',
      serviceUrl: 'http://localhost:5201',
      clientBuildId: 'collective-client-v1',
    };
    expect(collectiveClientAnchorSchema.parse(anchor)).toEqual(anchor);
    expect(() => collectiveClientAnchorSchema.parse({ ...anchor, serviceUrl: '/dev/f290' })).toThrow();
  });
});

function neverReached(): never {
  throw new Error('expected an Agent actor');
}
