import { createCatId } from '@cat-cafe/shared';

import { A2ADispatchDispositionService } from '../../dist/domains/ball-custody/A2ADispatchDispositionService.js';
import { BallCustodyIngest } from '../../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../../dist/domains/ball-custody/BallCustodyProjector.js';
import { buildHandedEvent } from '../../dist/domains/ball-custody/ball-custody-events.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';

class MemoryEventLog {
  events = [];

  async append(event) {
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { appended: false, sequence: -1 };
    }
    this.events.push(structuredClone(event));
    return { appended: true, sequence: this.events.length - 1 };
  }

  async appendFenced(event, expectedSequence) {
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { outcome: 'duplicate' };
    }
    if (this.events.filter((candidate) => candidate.subjectKey === event.subjectKey).length !== expectedSequence) {
      return {
        outcome: 'conflict',
        actualSequence: this.events.filter((candidate) => candidate.subjectKey === event.subjectKey).length,
      };
    }
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }

  async read(subjectKey, fromSequence = 0) {
    return this.events.filter((event) => event.subjectKey === subjectKey).slice(fromSequence);
  }

  async listSubjects() {
    return [...new Set(this.events.map((event) => event.subjectKey))];
  }
}

class MemoryProjectionStore {
  projections = new Map();

  async get(subjectKey) {
    return structuredClone(this.projections.get(subjectKey) ?? null);
  }

  async save(projection) {
    this.projections.set(projection.subjectKey, structuredClone(projection));
  }

  async listSubjectKeys() {
    return [...this.projections.keys()];
  }

  async delete(subjectKey) {
    this.projections.delete(subjectKey);
  }
}

export async function createA2ADispositionHarness({
  beforeDispositionRecord,
  sourceCatId = 'fable5',
  crossPostSourceThreadId,
  deliveryStatus,
  registry,
} = {}) {
  const eventLog = new MemoryEventLog();
  const projectionStore = new MemoryProjectionStore();
  const projector = new BallCustodyProjector(eventLog, projectionStore);
  const ingest = new BallCustodyIngest(eventLog, projector);
  const messageStore = new MessageStore();
  const source = messageStore.append({
    userId: 'user-1',
    catId: createCatId(sourceCatId),
    content: '@codex-sol review complete',
    mentions: [createCatId('codex-sol')],
    timestamp: 1_000,
    threadId: 'thread-1',
    origin: 'stream',
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(crossPostSourceThreadId
      ? {
          extra: {
            crossPost: {
              sourceThreadId: crossPostSourceThreadId,
              sourceInvocationId: 'source-invocation',
            },
          },
        }
      : {}),
  });
  await ingest.record(
    buildHandedEvent({
      threadId: 'thread-1',
      fromCatId: sourceCatId,
      toCatId: 'codex-sol',
      messageId: source.id,
      at: 1_000,
    }),
  );
  let latest = true;
  const fencedIngest = beforeDispositionRecord
    ? {
        record: (event) => ingest.record(event),
        async recordFenced(event, expectedSequence) {
          if (event.kind === 'ball.dispatch_dispositioned') {
            await beforeDispositionRecord({ event, ingest });
          }
          return ingest.recordFenced(event, expectedSequence);
        },
      }
    : ingest;
  const service = new A2ADispatchDispositionService({
    registry: registry ?? { isLatest: async (invocationId) => latest && invocationId === 'inv-1' },
    messageStore,
    ballCustodyEventLog: eventLog,
    ballCustodyProjectionStore: projectionStore,
    ballCustody: fencedIngest,
    repairProjection: (subjectKey) => projector.rebuild(subjectKey),
    now: () => 2_000,
  });
  return {
    eventLog,
    projectionStore,
    ingest,
    messageStore,
    source,
    service,
    setLatest(value) {
      latest = value;
    },
  };
}

export function createA2ADispositionAuth(harness, overrides = {}) {
  return {
    invocationId: 'inv-1',
    callbackToken: 'token',
    userId: 'user-1',
    ownerAuthProvenance: 'unknown',
    catId: createCatId('codex-sol'),
    threadId: 'thread-1',
    a2aTriggerMessageId: harness.source.id,
    originTriggerMessageId: harness.source.id,
    clientMessageIds: new Set(),
    createdAt: 1,
    expiresAt: 99_000,
    ...overrides,
  };
}

export function createA2ADispositionWake(harness) {
  return {
    kind: 'structured',
    protocol: 'dispatch',
    subjectKey: 'ball:thread:thread-1',
    holderCatId: 'codex-sol',
    handoff: {
      sourceEventId: `route:${harness.source.id}:codex-sol`,
      messageId: harness.source.id,
      fromCatId: 'fable5',
    },
  };
}
