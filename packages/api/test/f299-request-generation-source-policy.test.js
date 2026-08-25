import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let requestGenerationSourceKey;
let encodeMemoryCueSourceRef;
let encodeProfileSourceRef;
let requestGenerationMessageSourceRefs;
let requestGenerationPresentations;
let resolveRequestGenerationSourceStates;

before(async () => {
  ({
    encodeMemoryCueSourceRef,
    encodeProfileSourceRef,
    requestGenerationSourceKey,
    resolveRequestGenerationSourceStates,
  } = await import('../dist/domains/cats/services/session/request-generation-source-policy.js'));
  ({ requestGenerationMessageSourceRefs, requestGenerationPresentations } = await import(
    '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js'
  ));
});

describe('F299 request-generation source policy', () => {
  it('inherits message hard-delete, soft-delete, and owner scope without inventing absence truth', async () => {
    const messages = new Map([
      ['available', { id: 'available', threadId: 'thread-1', userId: 'owner-1' }],
      ['soft', { id: 'soft', threadId: 'thread-1', userId: 'owner-1', deletedAt: 10 }],
      ['hard', { id: 'hard', threadId: 'thread-1', userId: 'owner-1', deletedAt: 11, _tombstone: true }],
      ['foreign', { id: 'foreign', threadId: 'thread-1', userId: 'other-owner' }],
    ]);
    const refs = ['available', 'soft', 'hard', 'foreign', 'missing'].map((id) => ({
      owner: 'message',
      ref: `thread-1:${id}`,
    }));
    const states = await resolveRequestGenerationSourceStates(refs, {
      userId: 'owner-1',
      threadId: 'thread-1',
      invocationId: 'inv-1',
      messageStore: { getById: async (id) => messages.get(id) ?? null },
    });

    assert.deepEqual(
      refs.map((ref) => states.get(requestGenerationSourceKey(ref))),
      ['available', 'redacted', 'deleted', 'redacted', 'unknown'],
    );
  });

  it('asks canonical registry, profile, and memory owners instead of using unconditional available refs', async () => {
    const profileDigest = `hmac-sha256:${'b'.repeat(64)}`;
    const refs = [
      { owner: 'system_prompt', ref: 'registry:cat-cafe-owned' },
      { owner: 'system_prompt', ref: 'registry-revision:42' },
      { owner: 'home_state', ref: encodeProfileSourceRef('capsule', profileDigest) },
      {
        owner: 'memory',
        ref: encodeMemoryCueSourceRef({ family: 'person_memory', anchor: 'person-memory:p-1', revision: 'rev-1' }),
      },
      {
        owner: 'memory',
        ref: encodeMemoryCueSourceRef({
          family: 'person_memory',
          anchor: 'person-memory:forgotten',
          revision: 'rev-2',
        }),
      },
    ];
    const states = await resolveRequestGenerationSourceStates(refs, {
      userId: 'owner-1',
      threadId: 'thread-1',
      invocationId: 'inv-1',
      catId: 'codex-sol',
      keyedContentDigest: async () => profileDigest,
      profileRepository: {
        readCapsule: () => ({ content: 'current capsule', path: '/private/capsule' }),
        scope: (userId, catId) => ({ userId, catId, relationshipKey: 'codex-sol' }),
        readPrimer: () => null,
      },
      memoryCueSourceReader: {
        read: async ({ anchor }) =>
          anchor.endsWith('forgotten')
            ? { status: 'not_available', invalidationReason: 'source_forgotten' }
            : { status: 'ok', payload: {} },
      },
    });
    assert.deepEqual(
      refs.map((ref) => states.get(requestGenerationSourceKey(ref))),
      ['available', 'unknown', 'available', 'available', 'deleted'],
    );
  });

  it('maps recall resolver families to their canonical memory drill owners before reveal', async () => {
    const presentations = requestGenerationPresentations({
      admitted: [
        {
          envelope: {
            candidate: {
              subjectKey: 'memory-cue:person_entity:person-memory:p-1',
              asOf: { kind: 'version', value: 'rev-1' },
            },
            admission: {
              producerOwner: 'entity_nudge',
              sourceRefs: ['person-memory:p-1'],
            },
            receipt: {
              domain: 'memory_cue',
              receipt: {
                event: {
                  resolverFamily: 'person_entity',
                  sourceAnchor: 'person-memory:p-1',
                  sourceRevision: 'rev-1',
                },
              },
            },
          },
        },
        {
          envelope: {
            candidate: {
              subjectKey: 'memory-cue:operational_precedent:feature:F299',
              asOf: { kind: 'version', value: 'rev-2' },
            },
            admission: {
              producerOwner: 'workflow_sop',
              sourceRefs: ['feature:F299'],
            },
            receipt: {
              domain: 'memory_cue',
              receipt: {
                event: {
                  resolverFamily: 'operational_precedent',
                  sourceAnchor: 'feature:F299',
                  sourceRevision: 'rev-2',
                },
              },
            },
          },
        },
      ],
      omitted: [],
    });
    const refs = presentations.flatMap((presentation) => presentation.sourceRefs);
    const reads = [];
    const states = await resolveRequestGenerationSourceStates(refs, {
      userId: 'owner-1',
      threadId: 'thread-1',
      invocationId: 'inv-1',
      memoryCueSourceReader: {
        read: async (coordinate) => {
          reads.push(coordinate);
          return { status: 'ok', payload: {} };
        },
      },
    });

    assert.deepEqual(
      reads.map(({ family, anchor, expectedRevision }) => ({ family, anchor, expectedRevision })),
      [
        { family: 'person_memory', anchor: 'person-memory:p-1', expectedRevision: 'rev-1' },
        { family: 'evidence', anchor: 'feature:F299', expectedRevision: 'rev-2' },
      ],
    );
    assert.deepEqual(
      refs.map((ref) => states.get(requestGenerationSourceKey(ref))),
      ['available', 'available'],
    );
  });

  it('attributes submitted message bytes only to admitted presentations and concrete assembly owners', () => {
    const refs = requestGenerationMessageSourceRefs({
      threadId: 'thread-1',
      invocationId: 'inv-1',
      promptMessageIds: ['message-1'],
      presentations: [
        {
          owner: 'memory/private',
          kind: 'memory',
          decision: 'admitted',
          sourceRefs: [{ owner: 'memory', ref: 'cue:admitted' }],
        },
        {
          owner: 'memory/private',
          kind: 'memory',
          decision: 'omitted',
          sourceRefs: [{ owner: 'memory', ref: 'cue:omitted' }],
          reason: 'presentation_not_admitted',
        },
      ],
      injectSystemPrompt: true,
      hasContextHint: true,
      hasStagingPrepend: true,
      hasMissionPrefix: true,
    });

    assert.deepEqual(refs, [
      { owner: 'message', ref: 'thread-1:message-1' },
      { owner: 'memory', ref: 'cue:admitted' },
      { owner: 'system_prompt', ref: 'registry:cat-cafe-owned' },
      { owner: 'runtime_context', ref: 'context-management-hint:inv-1' },
      { owner: 'system_prompt', ref: 'staging:adr-038' },
      { owner: 'home_state', ref: 'thread-mission:thread-1' },
      { owner: 'runtime_context', ref: 'transcript-path-hints:thread-1' },
    ]);
  });

  it('redacts an older capsule revision and marks a forgotten capsule deleted', async () => {
    const expectedDigest = `hmac-sha256:${'a'.repeat(64)}`;
    const currentDigest = `hmac-sha256:${'b'.repeat(64)}`;
    const ref = { owner: 'home_state', ref: encodeProfileSourceRef('capsule', expectedDigest) };
    const base = {
      userId: 'owner-1',
      threadId: 'thread-1',
      invocationId: 'inv-1',
      catId: 'codex-sol',
      keyedContentDigest: async () => currentDigest,
    };
    const changed = await resolveRequestGenerationSourceStates([ref], {
      ...base,
      profileRepository: {
        readCapsule: () => ({ content: 'new capsule', path: '/private/capsule' }),
        scope: (userId, catId) => ({ userId, catId, relationshipKey: 'codex-sol' }),
        readPrimer: () => null,
      },
    });
    const forgotten = await resolveRequestGenerationSourceStates([ref], {
      ...base,
      profileRepository: {
        readCapsule: () => null,
        scope: (userId, catId) => ({ userId, catId, relationshipKey: 'codex-sol' }),
        readPrimer: () => null,
      },
    });

    assert.equal(changed.get(requestGenerationSourceKey(ref)), 'redacted');
    assert.equal(forgotten.get(requestGenerationSourceKey(ref)), 'deleted');
  });
});
