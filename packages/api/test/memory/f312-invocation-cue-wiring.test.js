import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { invokeSingleCat } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../../dist/domains/cats/services/session/ContextEpochOwner.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../../dist/domains/cats/services/session/PresentationLedger.js';
import { InMemoryContextEpochStore } from '../../dist/domains/cats/services/stores/ports/ContextEpochStore.js';

const CODEX_EXEC = {
  provider: 'openai',
  carrier: 'exec_json',
  reportsRuntimeWindow: true,
  authoritativeUsage: true,
  usageTelemetry: 'available',
  nativeWindowControl: true,
  nativeCompressionControl: true,
  observesCompression: true,
  reason: 'fixture',
};

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

function deps(overrides = {}) {
  return {
    registry: {
      create: async () => ({ invocationId: 'inv-f312', callbackToken: 'token-f312' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
    presentationLedger: new PresentationLedger(new InMemoryPresentationLedgerStore()),
    ...overrides,
  };
}

const service = {
  contextCapability: () => CODEX_EXEC,
  async *invoke() {
    yield { type: 'done', catId: 'codex', timestamp: Date.now() };
  },
};

function params(overrides = {}) {
  return {
    catId: 'codex',
    service,
    prompt: 'base prompt',
    userId: 'owner-1',
    ownerAuthProvenance: 'strict',
    threadId: 'thread-f312',
    invocationOrigin: 'interactive',
    routeTopology: 'serial',
    isLastCat: true,
    ...overrides,
  };
}

describe('F312 standing cue invocation wiring', () => {
  it('binds Profile and Event source-owned seeds only after strict interactive scope exists', async () => {
    const prepared = [];
    const resolved = [];
    const profileSeed = {
      kind: 'profile_revision_available',
      producer: 'profile_repository',
      occurredAt: 1,
      payload: {
        profileUri: 'cat-cafe-profile://relationship/current',
        sourceRevision: 'sha256:profile',
      },
    };
    const eventSeed = {
      kind: 'recent_event_available',
      producer: 'event_memory',
      occurredAt: 2,
      payload: {
        eventId: 'evt_1',
        subjectThreadId: 'thread-f312',
        sourceRevision: 'sha256:event',
      },
    };

    await collect(
      invokeSingleCat(
        deps({
          profileCueOpportunitySource: {
            async prepareOpportunity(input) {
              prepared.push({ lane: 'profile', input });
              return profileSeed;
            },
          },
          eventCueOpportunitySource: {
            async prepareOpportunity(input) {
              prepared.push({ lane: 'event', input });
              return eventSeed;
            },
          },
          memoryCuePromptService: {
            async resolve(input) {
              resolved.push(input);
              return {
                promptSegment: '',
                admittedOpportunityIds: [],
                omittedOpportunityIds: [],
                deliveryReceipts: [],
                presentationEnvelopes: [],
              };
            },
          },
        }),
        params(),
      ),
    );

    assert.deepEqual(
      prepared.map(({ lane, input }) => ({ lane, ownerUserId: input.ownerUserId, threadId: input.threadId })),
      [
        { lane: 'profile', ownerUserId: 'owner-1', threadId: undefined },
        { lane: 'event', ownerUserId: 'owner-1', threadId: 'thread-f312' },
      ],
    );
    assert.deepEqual(resolved[0].seeds, [profileSeed, eventSeed]);
    assert.deepEqual(resolved[0].serverScope, {
      ownerUserId: 'owner-1',
      threadId: 'thread-f312',
      invocationId: 'inv-f312',
    });
  });

  it('does not consult standing sources without strict owner provenance', async () => {
    let called = false;
    await collect(
      invokeSingleCat(
        deps({
          profileCueOpportunitySource: {
            async prepareOpportunity() {
              called = true;
              return null;
            },
          },
          eventCueOpportunitySource: {
            async prepareOpportunity() {
              called = true;
              return null;
            },
          },
        }),
        params({ ownerAuthProvenance: 'unknown' }),
      ),
    );
    assert.equal(called, false);
  });
});
