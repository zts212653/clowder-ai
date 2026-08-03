import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CommunityProjector } from '../dist/domains/community/community-projector.js';

function createStores() {
  const events = [];
  const projections = new Map();
  return {
    eventLog: {
      async append(event) {
        if (events.some((existing) => existing.sourceEventId === event.sourceEventId)) return { appended: false };
        events.push(event);
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

function event(kind, payload, id = kind) {
  return {
    sourceEventId: `f168:${id}`,
    subjectKey: 'issue:acme/widgets#42',
    kind,
    classification: kind === 'issue.commented' ? 'informational' : 'state-changing',
    payload,
    at: 1_700_000_000_000,
  };
}

describe('F168 issue fix evidence projection', () => {
  let eventLog;
  let objectStore;
  let projector;

  beforeEach(() => {
    ({ eventLog, objectStore } = createStores());
    projector = new CommunityProjector(eventLog, objectStore);
  });

  async function appendAndApply(next) {
    const { appended } = await eventLog.append(next);
    if (appended) await projector.apply(next);
  }

  it('does not project evidence from a prose-only fixed claim', async () => {
    await appendAndApply(event('issue.commented', { body: 'This is fixed now.' }, 'prose'));
    const projection = await objectStore.get('issue:acme/widgets#42');
    assert.strictEqual(projection.issueFixEvidence, null);
  });

  it('projects validated PR evidence embedded in a fix claim and preserves it on rebuild', async () => {
    await appendAndApply(
      event('issue.commented', { body: 'Fixed in https://github.com/acme/widgets/pull/87' }, 'pr-url'),
    );
    assert.deepStrictEqual((await objectStore.get('issue:acme/widgets#42')).issueFixEvidence, {
      kind: 'pull_request',
      url: 'https://github.com/acme/widgets/pull/87',
      number: 87,
    });

    await projector.rebuild('issue:acme/widgets#42');
    assert.deepStrictEqual((await objectStore.get('issue:acme/widgets#42')).issueFixEvidence, {
      kind: 'pull_request',
      url: 'https://github.com/acme/widgets/pull/87',
      number: 87,
    });
  });

  it('projects explicit reproduction evidence but rejects malformed evidence', async () => {
    await appendAndApply(
      event(
        'case.fix_evidence_recorded',
        { fixEvidence: { kind: 'reproduction', evidence: 'Run repro.js: 18 assertions pass.' } },
        'repro',
      ),
    );
    assert.deepStrictEqual((await objectStore.get('issue:acme/widgets#42')).issueFixEvidence, {
      kind: 'reproduction',
      evidence: 'Run repro.js: 18 assertions pass.',
    });

    await appendAndApply(
      event('case.fix_evidence_recorded', { fixEvidence: { kind: 'commit', sha: 'not-a-sha' } }, 'bad'),
    );
    const projection = await objectStore.get('issue:acme/widgets#42');
    assert.deepStrictEqual(projection.issueFixEvidence, {
      kind: 'reproduction',
      evidence: 'Run repro.js: 18 assertions pass.',
    });
    assert.strictEqual(projection.lastRejectedEvent.sourceEventId, 'f168:bad');
  });

  it('uses a merged linked PR cascade as structural issue fix evidence', async () => {
    await appendAndApply(event('pr.merged', { linkedPr: 'pr:acme/widgets#91', title: 'Fix issue 42' }, 'cascade'));
    assert.deepStrictEqual((await objectStore.get('issue:acme/widgets#42')).issueFixEvidence, {
      kind: 'pull_request',
      url: 'https://github.com/acme/widgets/pull/91',
      number: 91,
    });
  });
});
