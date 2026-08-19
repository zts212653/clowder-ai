import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CommunityProjector } from '../dist/domains/community/community-projector.js';

function createStores() {
  const events = [];
  const projections = new Map();
  return {
    eventLog: {
      async append(event) {
        if (events.some((existing) => existing.sourceEventId === event.sourceEventId)) return { appended: false };
        events.push(structuredClone(event));
        return { appended: true, sequence: events.length - 1 };
      },
      async read(subjectKey) {
        return events.filter((event) => event.subjectKey === subjectKey);
      },
      async listSubjects() {
        return [...new Set(events.map((event) => event.subjectKey))];
      },
    },
    objectStore: {
      async get(subjectKey) {
        return projections.get(subjectKey) ?? null;
      },
      async save(projection) {
        projections.set(projection.subjectKey, structuredClone(projection));
      },
      async delete(subjectKey) {
        projections.delete(subjectKey);
      },
      async listSubjectKeys() {
        return [...projections.keys()];
      },
    },
  };
}

const subjectKey = 'issue:acme/widgets#42';
const event = (id, kind, classification, payload, at) => ({
  sourceEventId: `f168:suppression:${id}`,
  subjectKey,
  kind,
  classification,
  payload,
  at,
});

async function appendAndApply(eventLog, projector, next) {
  const { appended } = await eventLog.append(next);
  if (appended) await projector.apply(next);
}

async function seedAwaitingExternal(eventLog, projector) {
  await appendAndApply(eventLog, projector, event('route', 'case.routed', 'state-changing', {}, 1_000));
  await appendAndApply(eventLog, projector, event('await', 'case.awaiting_external', 'state-changing', {}, 2_000));
}

describe('F168 exact suppression projection', () => {
  it('keeps exact setup noise out of state and external-activity projections across rebuild', async () => {
    const { eventLog, objectStore } = createStores();
    const projector = new CommunityProjector(eventLog, objectStore);
    await seedAwaitingExternal(eventLog, projector);
    await appendAndApply(
      eventLog,
      projector,
      event(
        'setup-noise',
        'issue.commented',
        'informational',
        {
          commentId: 99,
          authorLogin: 'chatgpt-codex-connector[bot]',
          critical: false,
          suppressionReason: 'exact_setup_noise',
        },
        3_000,
      ),
    );

    let projection = await objectStore.get(subjectKey);
    assert.equal(projection.state, 'awaiting_external');
    assert.equal(projection.lastExternalActivityAt, null, 'suppressed setup boilerplate is not external progress');

    await projector.rebuild(subjectKey);
    projection = await objectStore.get(subjectKey);
    assert.equal(projection.state, 'awaiting_external');
    assert.equal(projection.lastExternalActivityAt, null, 'rebuild must preserve the same suppression semantics');
  });

  it('lets a critical signal bypass an otherwise exact suppression reason', async () => {
    const { eventLog, objectStore } = createStores();
    const projector = new CommunityProjector(eventLog, objectStore);
    await seedAwaitingExternal(eventLog, projector);
    await appendAndApply(
      eventLog,
      projector,
      event(
        'critical',
        'issue.commented',
        'informational',
        {
          commentId: 100,
          authorLogin: 'chatgpt-codex-connector[bot]',
          critical: true,
          suppressionReason: 'exact_setup_noise',
        },
        4_000,
      ),
    );

    const projection = await objectStore.get(subjectKey);
    assert.equal(projection.state, 'in_progress');
    assert.equal(projection.lastExternalActivityAt, 4_000);
  });
});
