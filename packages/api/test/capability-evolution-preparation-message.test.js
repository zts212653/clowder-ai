import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const PROGRAM_ID = 'evolution-program:0123456789abcdef0123456789abcdef';
const source = { ownerFeatureId: 'F117', ownerStateRef: 'message:source', version: 'v1' };

function draft() {
  return {
    schemaVersion: 1,
    programId: PROGRAM_ID,
    section: 'object_map',
    title: 'PM capability candidates',
    authorCatId: 'codex-sol',
    dependsOn: [],
    body: {
      kind: 'object_map',
      goalStatement: '让 PM Agent 专业地推进项目，只在必要时请人介入',
      summary: 'Candidates are investigation directions, not write authority.',
      items: [
        {
          itemId: 'environment',
          label: 'Environment',
          scope: 'Current project environment',
          why: 'Separate environment failure from PM behavior.',
          modifiability: {
            state: 'not_modifiable_this_round',
            reason: 'The paired comparison freezes this environment.',
            basisRefs: [source],
          },
          sourceRefs: [source],
          nextAction: 'Keep it fixed while testing another primary variable.',
        },
      ],
      unknowns: ['No customer system is connected.'],
      nextAction: 'Inspect candidate owners and current versions.',
    },
  };
}

describe('F117 protected F311 preparation submission carrier', () => {
  it('derives one canonical revision independent of object key order and changes on content edits', async () => {
    const { deriveEvolutionPreparationSubmissionRevision } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const first = draft();
    const reordered = {
      body: first.body,
      dependsOn: first.dependsOn,
      authorCatId: first.authorCatId,
      title: first.title,
      section: first.section,
      programId: first.programId,
      schemaVersion: first.schemaVersion,
    };
    assert.equal(
      deriveEvolutionPreparationSubmissionRevision(first),
      deriveEvolutionPreparationSubmissionRevision(reordered),
    );
    assert.notEqual(
      deriveEvolutionPreparationSubmissionRevision(first),
      deriveEvolutionPreparationSubmissionRevision({ ...first, title: 'Changed title' }),
    );
  });

  it('keeps the authoritative carrier immutable across generic host and stream extra patches', async () => {
    const { MessageStore, deriveEvolutionPreparationSubmissionRevision } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();
    const payload = draft();
    const submission = { ...payload, revision: deriveEvolutionPreparationSubmissionRevision(payload) };
    const stored = store.append({
      userId: 'operator',
      threadId: 'thread-preparation',
      catId: 'codex-sol',
      content: '已提交 PM capability candidates 准备修订。',
      mentions: [],
      origin: 'callback',
      timestamp: 1,
      extra: { evolutionPreparationSubmissionV1: submission },
    });

    store.updateExtra(stored.id, {
      evolutionPreparationSubmissionV1: { ...submission, title: 'malicious generic patch' },
      tracing: { traceId: 'trace', spanId: 'span' },
    });
    store.augmentStreamMetadata(stored.id, {
      extra: { evolutionPreparationSubmissionV1: { ...submission, title: 'malicious stream patch' } },
    });
    const reread = store.getById(stored.id);
    assert.deepEqual(reread?.extra?.evolutionPreparationSubmissionV1, submission);
    assert.deepEqual(reread?.extra?.tracing, { traceId: 'trace', spanId: 'span' });
  });

  it('rejects a preparation carrier whose authenticated cat author does not match', async () => {
    const { MessageStore, deriveEvolutionPreparationSubmissionRevision } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const payload = draft();
    const submission = { ...payload, revision: deriveEvolutionPreparationSubmissionRevision(payload) };
    assert.throws(() =>
      new MessageStore().append({
        userId: 'operator',
        threadId: 'thread-preparation',
        catId: 'codex-terra',
        content: 'spoof',
        mentions: [],
        timestamp: 1,
        extra: { evolutionPreparationSubmissionV1: submission },
      }),
    );
  });
});
