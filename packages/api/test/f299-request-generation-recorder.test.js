import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let createRequestGenerationRecorder;

before(async () => {
  ({ createRequestGenerationRecorder } = await import(
    '../dist/domains/cats/services/agents/invocation/request-generation-recorder.js'
  ));
});

function fixture(overrides = {}) {
  const appended = [];
  const active = {
    id: 'session-1',
    threadId: 'thread-1',
    catId: 'codex-sol',
    userId: 'user-1',
    seq: 0,
    status: 'active',
  };
  const recorder = createRequestGenerationRecorder({
    invocationId: 'inv-1',
    threadId: 'thread-1',
    userId: 'user-1',
    catId: 'codex-sol',
    transcriptWriter: {
      keyedContentDigest: async (body) => `hmac-sha256:${body === 'message' ? 'a' : 'b'}`.padEnd(76, '0'),
      appendDurableEvent: async (session, event, invocationId) => {
        appended.push({ session, event, invocationId });
      },
    },
    sessionChainStore: { getActive: async () => active },
    snapshot: () => ({
      continuity: { capability: 'unknown', compactionRefs: [] },
      messageSourceRefs: [{ owner: 'message', ref: 'thread-1:message-1' }],
      nativeInstructionSourceRefs: [{ owner: 'system_prompt', ref: 'l0:revision-1' }],
      presentations: [],
    }),
    now: () => 123,
    createId: () => '00000000-0000-4000-8000-000000000001',
    ...overrides,
  });
  return { active, appended, recorder };
}

function prepared() {
  return Object.freeze({
    v: 1,
    message: Object.freeze({ body: 'message', injectionDecision: 'cold_identity_injected' }),
    nativeInstructions: Object.freeze([Object.freeze({ body: 'native', injectionDecision: 'native_l0_compiled' })]),
    runtime: Object.freeze({ provider: 'openai', carrier: 'app_server', model: 'gpt-5.6-sol' }),
    tools: Object.freeze({ finalSurface: 'unknown' }),
    providerNativeVisibility: 'unsupported',
  });
}

describe('F299 request-generation recorder', () => {
  it('durably appends exact prepared channels to the active Session before resolving', async () => {
    const { active, appended, recorder } = fixture();
    const commit = await recorder.recordPrepared(prepared(), { attempt: 1 });

    assert.deepEqual(commit, {
      requestGenerationId: '00000000-0000-4000-8000-000000000001',
      generationOrdinal: 1,
      sessionId: active.id,
    });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].event.envelope.channels[0].body, 'message');
    assert.equal(appended[0].event.envelope.channels[1].body, 'native');
    assert.equal(appended[0].event.envelope.channels[2].accuracy, 'unsupported');
  });

  it('uses per-channel source refs and binds embedded profile bytes to the canonical profile owner', async () => {
    const capsuleDigest = `hmac-sha256:${'c'.repeat(64)}`;
    const { appended, recorder } = fixture({
      transcriptWriter: {
        keyedContentDigest: async (body) =>
          body === '## 主人画像\n\nprivate capsule' ? capsuleDigest : `hmac-sha256:${'a'.repeat(64)}`,
        appendDurableEvent: async (session, event, invocationId) => {
          appended.push({ session, event, invocationId });
        },
      },
      profileRepository: {
        readCapsule: () => ({ content: 'private capsule', path: '/private/capsule' }),
        scope: (userId, catId) => ({ userId, catId, relationshipKey: 'codex-sol' }),
        readPrimer: () => null,
      },
    });
    const request = prepared();
    await recorder.recordPrepared(
      {
        ...request,
        message: { ...request.message, sourceRefs: [{ owner: 'runtime_context', ref: 'capacity-recovery:inv-1' }] },
        nativeInstructions: [
          {
            body: '## 主人画像\n\nprivate capsule',
            injectionDecision: 'native_l0_compiled',
            sourceRefs: [{ owner: 'system_prompt', ref: 'registry:cat-cafe-owned' }],
          },
        ],
      },
      { attempt: 1 },
    );

    assert.deepEqual(appended[0].event.envelope.channels[0].sourceRefs, [
      { owner: 'runtime_context', ref: 'capacity-recovery:inv-1' },
    ]);
    assert.deepEqual(appended[0].event.envelope.channels[1].sourceRefs, [
      { owner: 'system_prompt', ref: 'registry:cat-cafe-owned' },
      { owner: 'home_state', ref: `profile-capsule:${capsuleDigest}` },
    ]);
  });

  it('does not bind a newer profile revision to already-compiled native bytes', async () => {
    const { appended, recorder } = fixture({
      profileRepository: {
        readCapsule: () => ({ content: 'new capsule', path: '/private/capsule' }),
        scope: (userId, catId) => ({ userId, catId, relationshipKey: 'codex-sol' }),
        readPrimer: () => null,
      },
    });
    const request = prepared();
    await recorder.recordPrepared(
      {
        ...request,
        nativeInstructions: [
          {
            body: '## 主人画像\n\nold capsule',
            injectionDecision: 'native_l0_compiled',
          },
        ],
      },
      { attempt: 1 },
    );

    assert.deepEqual(appended[0].event.envelope.channels[1].sourceRefs, [
      { owner: 'system_prompt', ref: 'l0:revision-1' },
      { owner: 'home_state', ref: 'profile-capsule:unresolved' },
    ]);
  });

  it('rejects before launch when durable transcript persistence fails', async () => {
    const { recorder } = fixture({
      transcriptWriter: {
        keyedContentDigest: async () => `hmac-sha256:${'a'.repeat(64)}`,
        appendDurableEvent: async () => {
          throw new Error('disk-full');
        },
      },
    });
    await assert.rejects(recorder.recordPrepared(prepared(), { attempt: 1 }), /disk-full/);
  });

  it('links retry generations monotonically across an active Session replacement', async () => {
    const sessions = [
      { id: 'session-1', threadId: 'thread-1', catId: 'codex-sol', userId: 'user-1', seq: 0 },
      { id: 'session-2', threadId: 'thread-1', catId: 'codex-sol', userId: 'user-1', seq: 1 },
    ];
    let read = 0;
    let id = 0;
    const { appended, recorder } = fixture({
      sessionChainStore: { getActive: async () => sessions[read++] },
      createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    });

    await recorder.recordPrepared(prepared(), { attempt: 1 });
    await recorder.recordPrepared(prepared(), { attempt: 2, reason: 'missing_session' });

    assert.deepEqual(
      appended.map(({ event }) => ({
        sessionId: event.envelope.sessionId,
        ordinal: event.envelope.generationOrdinal,
        boundary: event.envelope.retryBoundary,
      })),
      [
        { sessionId: 'session-1', ordinal: 1, boundary: { attempt: 1 } },
        {
          sessionId: 'session-2',
          ordinal: 2,
          boundary: { attempt: 2, previousGenerationOrdinal: 1, reason: 'missing_session' },
        },
      ],
    );
  });

  it('appends observed and terminal lifecycle evidence to the active Session without rewriting assembly', async () => {
    const { active, appended, recorder } = fixture();
    const commit = await recorder.recordPrepared(prepared(), { attempt: 1 });
    active.id = 'session-2';
    active.seq = 1;

    await recorder.recordObserved(commit, {
      runtimeSessionId: 'runtime-1',
      model: 'gpt-5.6-sol',
      evidenceRef: 'provider_event:inv-1:1:session_init:124',
    });
    await recorder.recordObserved(commit, {
      evidenceRef: 'provider_event:inv-1:1:text:125',
    });
    await recorder.recordTerminal(commit, 'accepted');
    await recorder.recordTerminal(commit, 'error', 'must-not-overwrite');

    assert.deepEqual(
      appended.map(({ session, event }) => ({ sessionId: session.sessionId, type: event.type })),
      [
        { sessionId: 'session-1', type: 'request_generation_assembled' },
        { sessionId: 'session-2', type: 'request_generation_observed' },
        { sessionId: 'session-2', type: 'request_generation_terminal' },
      ],
    );
    assert.deepEqual(appended[1].event.evidence, {
      provider: 'openai',
      carrier: 'app_server',
      model: 'gpt-5.6-sol',
      runtimeSessionId: 'runtime-1',
      evidenceRef: 'provider_event:inv-1:1:session_init:124',
    });
    assert.equal(appended[2].event.outcome, 'accepted');
  });

  it('rejects secret-bearing runtime fields before persisting the assembled event', async () => {
    const { appended, recorder } = fixture();
    await assert.rejects(
      recorder.recordPrepared(
        {
          ...prepared(),
          runtime: { ...prepared().runtime, apiKey: 'do-not-persist' },
        },
        { attempt: 1 },
      ),
      /Unrecognized key/,
    );
    assert.equal(appended.length, 0);
  });

  it('persists keyed tool-set hashes without copying raw schemas or server config', async () => {
    const digested = [];
    const appended = [];
    const { recorder } = fixture({
      transcriptWriter: {
        keyedContentDigest: async (body) => {
          digested.push(body);
          return `hmac-sha256:${'c'.repeat(64)}`;
        },
        appendDurableEvent: async (session, event, invocationId) => {
          appended.push({ session, event, invocationId });
        },
      },
    });
    const readSchema = {
      name: 'read_file',
      description: 'raw-schema-must-not-persist',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    };
    const listSchema = {
      name: 'list_files',
      description: 'list files',
      input_schema: { properties: {}, type: 'object' },
    };
    await recorder.recordPrepared(
      {
        ...prepared(),
        tools: {
          finalSurface: 'exact',
          declaredServerNames: ['cat-cafe-memory', 'cat-cafe-collab', 'cat-cafe-memory'],
          catCafeSchemas: [readSchema, listSchema],
          providerObservedSchemas: [listSchema, readSchema],
        },
      },
      { attempt: 1 },
    );

    const stored = appended[0].event.envelope.tools;
    assert.equal(stored.finalSurface, 'exact');
    assert.match(stored.declaredServerSetHash, /^hmac-sha256:[a-f0-9]{64}$/);
    assert.match(stored.catCafeSchemaSetHash, /^hmac-sha256:[a-f0-9]{64}$/);
    assert.match(stored.providerObservedSchemaSetHash, /^hmac-sha256:[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(stored).includes('raw-schema-must-not-persist'));
    assert.ok(!JSON.stringify(stored).includes('cat-cafe-memory'));
    assert.ok(digested.includes('["cat-cafe-collab","cat-cafe-memory"]'));
    assert.equal(digested.at(-1), digested.at(-2), 'schema-set hashes must ignore provider ordering');
  });
});
