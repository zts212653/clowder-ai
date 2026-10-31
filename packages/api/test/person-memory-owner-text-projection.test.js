import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const OWNER_ID = 'owner-1';
const MESSAGE_ID = 'message-quote-comment';
const COMMENT = '从现在开始到10.7号吴浪去旅游了，他的 Mac 交给我了';
const QUOTED_TEXT = '我的立场是先在 Alpha 里完成双人协作验证';

function ownerMessage({
  content = '',
  comment = COMMENT,
  quotedText = QUOTED_TEXT,
  sourceMessageId = 'message-source',
} = {}) {
  return {
    id: MESSAGE_ID,
    threadId: 'thread-people',
    userId: OWNER_ID,
    catId: null,
    content,
    timestamp: 1,
    contentBlocks: [
      {
        type: 'context_attachment',
        attachment: {
          v: 1,
          id: 'ctx-quote-1',
          kind: 'quote',
          text: quotedText,
          comment,
          source: {
            kind: 'message',
            threadId: 'thread-source',
            messageId: sourceMessageId,
          },
        },
      },
    ],
  };
}

function sourceBundle(excerpt) {
  return {
    sources: [{ sourceId: 'owner-source', kind: 'message_text', messageId: MESSAGE_ID, excerpt }],
    assertionBindings: [
      {
        sourceId: 'owner-source',
        target: { kind: 'claim', index: 0 },
        role: 'reported_fact',
      },
    ],
  };
}

describe('F276 owner-authored text projection', () => {
  it('accepts an owner quote comment and aligns its immediate/deferred coordinate digest', async () => {
    const [{ PersonMemorySourceBundleResolver }, { DeferredPersonMemorySourceResolver }] = await Promise.all([
      import('../dist/domains/memory/people/PersonMemorySourceBundleResolver.js'),
      import('../dist/domains/memory/DeferredPersonMemorySourceResolver.js'),
    ]);
    const message = ownerMessage();
    const messageStore = { getById: async (messageId) => (messageId === MESSAGE_ID ? message : null) };

    const immediate = await new PersonMemorySourceBundleResolver({ messageStore }).resolve(
      sourceBundle('吴浪去旅游了，他的 Mac 交给我了'),
      { ownerUserId: OWNER_ID },
      { claimDraftIds: ['person_draft_1'] },
    );
    assert.equal(immediate.status, 'resolved');

    const deferred = await new DeferredPersonMemorySourceResolver(messageStore).resolve(
      [{ kind: 'message', messageId: MESSAGE_ID }],
      OWNER_ID,
    );
    assert.equal(deferred.status, 'resolved');
    assert.equal(immediate.bundle.sources[0].resolvedDigest, deferred.coordinates[0].resolvedDigest);
  });

  it('never treats the quoted text as an owner assertion', async () => {
    const { PersonMemorySourceBundleResolver } = await import(
      '../dist/domains/memory/people/PersonMemorySourceBundleResolver.js'
    );
    const message = ownerMessage();
    const messageStore = { getById: async () => message };

    const result = await new PersonMemorySourceBundleResolver({ messageStore }).resolve(
      sourceBundle('先在 Alpha 里完成双人协作验证'),
      { ownerUserId: OWNER_ID },
      { claimDraftIds: ['person_draft_1'] },
    );

    assert.deepEqual(result, { status: 'invalid', error: 'source_excerpt_mismatch' });
  });

  it('uses quote comments for explicit accuracy confirmation but not quoted text', async () => {
    const { explicitlyConfirmsAccuracy } = await import(
      '../dist/domains/memory/people/PersonMemorySourceBundleResolver.js'
    );

    assert.equal(explicitlyConfirmsAccuracy(ownerMessage({ comment: '对，转写内容准确' })), true);
    assert.equal(
      explicitlyConfirmsAccuracy(ownerMessage({ comment: '这里只是批注', quotedText: '对，转写内容准确' })),
      false,
    );
  });

  it('changes the coordinate digest when a comment-only source changes', async () => {
    const { DeferredPersonMemorySourceResolver } = await import(
      '../dist/domains/memory/DeferredPersonMemorySourceResolver.js'
    );
    let message = ownerMessage();
    const messageStore = { getById: async () => message };
    const resolver = new DeferredPersonMemorySourceResolver(messageStore);

    const initial = await resolver.resolve([{ kind: 'message', messageId: MESSAGE_ID }], OWNER_ID);
    assert.equal(initial.status, 'resolved');
    message = ownerMessage({ comment: `${COMMENT}，10.8 归还` });
    const changed = await resolver.resolve([{ kind: 'message', messageId: MESSAGE_ID }], OWNER_ID);
    assert.equal(changed.status, 'resolved');
    assert.notEqual(initial.coordinates[0].resolvedDigest, changed.coordinates[0].resolvedDigest);
  });

  it('fails immediate revalidation when accepted comment evidence changes beside a stable body', async () => {
    const { PersonMemorySourceBundleResolver } = await import(
      '../dist/domains/memory/people/PersonMemorySourceBundleResolver.js'
    );
    let message = ownerMessage({ content: '我看到了这条引用' });
    const messageStore = { getById: async () => message };
    const resolver = new PersonMemorySourceBundleResolver({ messageStore });
    const input = sourceBundle('吴浪去旅游了，他的 Mac 交给我了');
    const targets = { claimDraftIds: ['person_draft_1'] };

    const initial = await resolver.resolve(input, { ownerUserId: OWNER_ID }, targets);
    assert.equal(initial.status, 'resolved');
    message = ownerMessage({ content: '我看到了这条引用', comment: `${COMMENT}（更正：没有去）` });

    assert.deepEqual(await resolver.revalidate(input, { ownerUserId: OWNER_ID }, targets, initial.bundleDigest), {
      status: 'invalid',
      error: 'source_drift',
    });
  });

  it('fails deferred revalidation when the paired quote text or source identity changes', async () => {
    const { DeferredPersonMemorySourceResolver } = await import(
      '../dist/domains/memory/DeferredPersonMemorySourceResolver.js'
    );
    let message = ownerMessage();
    const messageStore = { getById: async () => message };
    const resolver = new DeferredPersonMemorySourceResolver(messageStore);
    const sources = [{ kind: 'message', messageId: MESSAGE_ID }];

    const initial = await resolver.resolve(sources, OWNER_ID);
    assert.equal(initial.status, 'resolved');

    message = ownerMessage({ quotedText: `${QUOTED_TEXT}（已编辑）` });
    assert.deepEqual(await resolver.revalidate(sources, OWNER_ID, initial.bundleDigest), {
      status: 'invalid',
      error: 'source_drift',
    });

    message = ownerMessage({ sourceMessageId: 'message-source-replaced' });
    assert.deepEqual(await resolver.revalidate(sources, OWNER_ID, initial.bundleDigest), {
      status: 'invalid',
      error: 'source_drift',
    });
  });

  it('fails closed when the same excerpt matches both the body and a quote comment', async () => {
    const { PersonMemorySourceBundleResolver } = await import(
      '../dist/domains/memory/people/PersonMemorySourceBundleResolver.js'
    );
    const message = ownerMessage({
      content: '吴浪去旅游了',
      comment: '吴浪去旅游了（更正：没有去）',
    });
    const messageStore = { getById: async () => message };

    assert.deepEqual(
      await new PersonMemorySourceBundleResolver({ messageStore }).resolve(
        sourceBundle('吴浪去旅游了'),
        { ownerUserId: OWNER_ID },
        { claimDraftIds: ['person_draft_1'] },
      ),
      { status: 'invalid', error: 'source_excerpt_mismatch' },
    );
  });

  it('preserves the historical digest for messages that contain only owner body evidence', async () => {
    const { digestPersonMemorySourceMaterial } = await import(
      '../dist/domains/memory/people/PersonMemorySourceBundleResolver.js'
    );
    const { ownerMessageTextDigestMaterial } = await import(
      '../dist/domains/memory/people/owner-message-text-projection.js'
    );
    const body = '  只有正文的历史证据  ';

    assert.equal(
      digestPersonMemorySourceMaterial(ownerMessageTextDigestMaterial(ownerMessage({ content: body, comment: '' }))),
      digestPersonMemorySourceMaterial(body),
    );
  });

  it('uses the same owner segments in legacy source lookup and interaction laundering checks', async () => {
    const [{ PersonMemorySourceBundleResolver }, sourceContract] = await Promise.all([
      import('../dist/domains/memory/people/PersonMemorySourceBundleResolver.js'),
      import('../dist/routes/person-memory-proposal-source-contract.js'),
    ]);
    const relayedComment = '张三告诉我他昨天去了北京';
    const message = ownerMessage({ comment: relayedComment });
    const messageStore = { getById: async (messageId) => (messageId === MESSAGE_ID ? message : null) };
    const auth = { userId: OWNER_ID, threadId: 'thread-current' };

    const historicalSource = await sourceContract.resolveProposalSourceMessageId(
      messageStore,
      {
        sourceMessageId: MESSAGE_ID,
        claims: [{ evidenceExcerpt: relayedComment }],
      },
      auth,
      'message-current',
    );
    assert.equal(historicalSource, MESSAGE_ID);
    assert.equal(
      await sourceContract.resolveProposalSourceMessageId(
        messageStore,
        {
          sourceMessageId: MESSAGE_ID,
          claims: [{ evidenceExcerpt: QUOTED_TEXT }],
        },
        auth,
        'message-current',
      ),
      null,
    );

    const legacyInteraction = {
      sources: [{ messageId: MESSAGE_ID, evidenceExcerpt: relayedComment, supports: ['headline'] }],
    };
    assert.equal(
      (await sourceContract.resolveInteractionSourceEvidence(messageStore, legacyInteraction, auth)).length,
      1,
    );
    assert.equal(
      await sourceContract.resolveInteractionSourceEvidence(
        messageStore,
        { sources: [{ messageId: MESSAGE_ID, evidenceExcerpt: QUOTED_TEXT, supports: ['headline'] }] },
        auth,
      ),
      null,
    );

    const typed = await new PersonMemorySourceBundleResolver({ messageStore }).resolve(
      {
        sources: [
          { sourceId: 'relayed-comment', kind: 'message_text', messageId: MESSAGE_ID, excerpt: '他昨天去了北京' },
        ],
        assertionBindings: [
          {
            sourceId: 'relayed-comment',
            target: { kind: 'interaction', field: 'headline' },
            role: 'reported_fact',
          },
        ],
      },
      { ownerUserId: OWNER_ID },
      { claimDraftIds: [], interactionDraftId: 'person_draft_interaction' },
    );
    assert.equal(typed.status, 'resolved');
    assert.equal(await sourceContract.resolvedBindingsAreMaterializable(typed.bundle, messageStore), false);
  });
});
