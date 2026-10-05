import { describe, expect, it } from 'vitest';

import {
  type CollectiveEventEnvelope,
  collectiveAckRequestSchema,
  collectiveClientAnchorSchema,
  collectiveEventEnvelopeSchema,
  collectiveHumanMessageRequestSchema,
  collectivePairingBridgeMessageSchema,
  collectivePairingIntentSchema,
  collectivePairingMessageSchema,
} from '../types/collective.js';
import {
  collectiveClientWorkResultAcceptedSchema,
  collectiveClientWorldDirectorySchema,
  collectiveHostParticipationReadySchema,
  collectiveHostWorkFocusSchema,
  collectiveHostWorldDirectoryInitSchema,
  collectiveHostWorldSelectionSchema,
  collectiveWorldDirectoryReadySchema,
} from '../types/collective-context-bridge.js';

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

  it('requires a Service-issued notice for revision feedback and rejects Human-side forgery', () => {
    const revisionNotice = {
      v: 1 as const,
      workId: 'work_01J7WB6E2N3G8JQ1SM7X23D4QC',
      workRevision: 4,
      assignmentEventId: 'evt_01J7WB6E2N3G8JQ1SM7X23D4QD',
      resultEventId: 'evt_01J7WB6E2N3G8JQ1SM7X23D4QE',
      resultRevision: 2,
    };
    const revisionEvent = {
      ...agentEvent(),
      actor: { kind: 'human' as const, humanId: 'human_01J7WB6E2N3G8JQ1SM7X23D4QB', displayName: 'You' },
      target: {
        kind: 'agent' as const,
        humanId: 'human_01J7WB6E2N3G8JQ1SM7X23D4QB',
        agentId: 'codex-sol',
      },
      workRequest: 'revise' as const,
      workRevisionNotice: revisionNotice,
      body: 'Please revise the result with the missing evidence.',
    };
    expect(collectiveEventEnvelopeSchema.parse(revisionEvent).workRevisionNotice).toEqual(revisionNotice);
    expect(() => collectiveEventEnvelopeSchema.parse({ ...revisionEvent, workRevisionNotice: undefined })).toThrow();

    const humanRequest = {
      ...coordinates,
      clientEventId: 'human-feedback-1',
      target: revisionEvent.target,
      body: revisionEvent.body,
    };
    expect(() =>
      collectiveHumanMessageRequestSchema.parse({
        ...humanRequest,
        workRequest: 'revise',
        workRevisionNotice: revisionNotice,
      }),
    ).toThrow();
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

  it('accepts only bounded public participation readiness on one exact Host bridge', () => {
    const ready = {
      type: 'collective:host-participation-ready',
      bridgeId: 'bridge_12345678',
      ...coordinates,
      connectionId: 'con_01J7WB6E2N3G8JQ1SM7X23D4Q8',
      humanId: 'human_01J7WB6E2N3G8JQ1SM7X23D4QB',
      participationRevision: 1,
      catCount: 0,
    };
    expect(collectiveHostParticipationReadySchema.parse(ready)).toEqual(ready);
    expect(() => collectiveHostParticipationReadySchema.parse({ ...ready, catCount: -1 })).toThrow();
    expect(() =>
      collectiveHostParticipationReadySchema.parse({ ...ready, privateThreadId: 'thread_secret' }),
    ).toThrow();
  });

  it('binds a completed Work notice to one live Host bridge and exact public evidence', () => {
    const notice = {
      type: 'collective:client-work-result-accepted',
      bridgeId: 'bridge_12345678',
      contextId: 'context_12345678',
      contextRevision: 3,
      ...coordinates,
      connectionId: 'con_01J7WB6E2N3G8JQ1SM7X23D4Q8',
      humanId: 'human_01J7WB6E2N3G8JQ1SM7X23D4QB',
      workId: 'work_01J7WB6E2N3G8JQ1SM7X23D4QC',
      workRevision: 4,
      assignmentEventId: 'evt_01J7WB6E2N3G8JQ1SM7X23D4QD',
      resultEventId: 'evt_01J7WB6E2N3G8JQ1SM7X23D4QE',
      resultRevision: 2,
    };
    expect(collectiveClientWorkResultAcceptedSchema.parse(notice)).toEqual(notice);
    expect(() => collectiveClientWorkResultAcceptedSchema.parse({ ...notice, contextRevision: 0 })).toThrow();
    expect(() => collectiveClientWorkResultAcceptedSchema.parse({ ...notice, resultRevision: 0 })).toThrow();
    expect(() => collectiveClientWorkResultAcceptedSchema.parse({ ...notice, privateTaskId: 'task-secret' })).toThrow();
  });

  it('binds exact Work focus to one current Host bridge without private Task coordinates', () => {
    const focus = {
      type: 'collective:host-focus-work',
      bridgeId: 'bridge_12345678',
      contextId: 'context_12345678',
      contextRevision: 3,
      workId: 'work_01J7WB6E2N3G8JQ1SM7X23D4QC',
      workRevision: 4,
      channelId: 'general',
      resultEventId: 'evt_01J7WB6E2N3G8JQ1SM7X23D4QE',
      resultRevision: 2,
    };
    expect(collectiveHostWorkFocusSchema.parse(focus)).toEqual(focus);
    expect(() => collectiveHostWorkFocusSchema.parse({ ...focus, workRevision: 0 })).toThrow();
    expect(() => collectiveHostWorkFocusSchema.parse({ ...focus, resultRevision: 0 })).toThrow();
    expect(() => collectiveHostWorkFocusSchema.parse({ ...focus, privateTaskId: 'task-secret' })).toThrow();
  });

  it('carries only the current Human world directory across a generation-fenced Host bridge', () => {
    const bridgeId = 'bridge_12345678';
    const humanId = 'human_01J7WB6E2N3G8JQ1SM7X23D4QB';
    expect(collectiveWorldDirectoryReadySchema.parse({ type: 'collective:world-directory-ready' })).toEqual({
      type: 'collective:world-directory-ready',
    });
    expect(
      collectiveHostWorldDirectoryInitSchema.parse({
        type: 'collective:host-world-directory-init',
        bridgeId,
        expectedServiceInstanceId: coordinates.serviceInstanceId,
      }),
    ).toMatchObject({ bridgeId, expectedServiceInstanceId: coordinates.serviceInstanceId });

    const directory = {
      type: 'collective:client-world-directory',
      bridgeId,
      revision: 1,
      state: 'ready',
      serviceInstanceId: coordinates.serviceInstanceId,
      humanId,
      currentCollectiveId: coordinates.collectiveId,
      memberships: [
        { collectiveId: coordinates.collectiveId, name: 'Alpha', role: 'steward' },
        { collectiveId: 'col_01J7WB6E2N3G8JQ1SM7X23D4QZ', name: 'Private room', role: 'member' },
      ],
    } as const;
    expect(collectiveClientWorldDirectorySchema.parse(directory)).toEqual(directory);
    expect(() =>
      collectiveClientWorldDirectorySchema.parse({ ...directory, sessionToken: 'private-session' }),
    ).toThrow();
    expect(() =>
      collectiveClientWorldDirectorySchema.parse({ ...directory, privateThreadId: 'thread_secret' }),
    ).toThrow();

    const selection = {
      type: 'collective:host-select-world',
      bridgeId,
      directoryRevision: 1,
      serviceInstanceId: coordinates.serviceInstanceId,
      humanId,
      collectiveId: directory.memberships[1].collectiveId,
    } as const;
    expect(collectiveHostWorldSelectionSchema.parse(selection)).toEqual(selection);
    expect(() => collectiveHostWorldSelectionSchema.parse({ ...selection, directoryRevision: 0 })).toThrow();
  });
});

function neverReached(): never {
  throw new Error('expected an Agent actor');
}
