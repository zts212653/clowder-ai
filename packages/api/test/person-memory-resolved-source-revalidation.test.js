import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  digestPersonMemorySourceMaterial,
  PersonMemorySourceBundleResolver,
} from '../dist/domains/memory/people/PersonMemorySourceBundleResolver.js';

const ownerUserId = 'owner-1';
const targets = { claimDraftIds: ['person_draft_revalidate'] };
const binding = {
  sourceId: 'source-1',
  target: { kind: 'claim', index: 0 },
  role: 'reported_fact',
};

function ownerMessage(id, content, extra = {}) {
  return {
    id,
    threadId: 'thread-revalidate',
    userId: ownerUserId,
    catId: null,
    content,
    timestamp: 1,
    deliveryStatus: 'delivered',
    ...extra,
  };
}

async function resolvedBundle(resolver, source) {
  const result = await resolver.resolve(
    { sources: [{ sourceId: 'source-1', ...source }], assertionBindings: [binding] },
    { ownerUserId },
    targets,
  );
  assert.equal(result.status, 'resolved');
  return result.bundle;
}

describe('F276 resolved provenance revalidation', () => {
  it('revalidates attachment coordinates and fails closed after attachment drift', async () => {
    const block = { type: 'text', text: '附件中的人物事实' };
    let message = ownerMessage('message-attachment', '', { contentBlocks: [block] });
    const resolver = new PersonMemorySourceBundleResolver({ messageStore: { getById: async () => message } });
    const bundle = await resolvedBundle(resolver, {
      kind: 'message_attachment',
      messageId: message.id,
      attachmentLocator: { surface: 'content_block', index: 0 },
      expectedDigest: digestPersonMemorySourceMaterial(block),
      boundedTranscript: '人物事实',
    });
    assert.equal((await resolver.revalidateResolvedBundle(bundle, { ownerUserId })).status, 'resolved');
    message = { ...message, contentBlocks: [{ ...block, text: '已经被编辑' }] };
    assert.equal((await resolver.revalidateResolvedBundle(bundle, { ownerUserId })).status, 'invalid');
  });

  it('revalidates confirmed transcript evidence and rejects a withdrawn confirmation', async () => {
    let message = ownerMessage('message-confirmation', '对，转写内容准确');
    const resolver = new PersonMemorySourceBundleResolver({ messageStore: { getById: async () => message } });
    const transcript = '黄挺参加了这次会议';
    const bundle = await resolvedBundle(resolver, {
      kind: 'owner_confirmed_transcript',
      transcript,
      transcriptDigest: digestPersonMemorySourceMaterial(transcript),
      confirmationMessageId: message.id,
      confirmationScope: 'transcript_accuracy',
    });
    assert.equal((await resolver.revalidateResolvedBundle(bundle, { ownerUserId })).status, 'resolved');
    message = { ...message, content: '不对，转写内容不准确' };
    assert.deepEqual(await resolver.revalidateResolvedBundle(bundle, { ownerUserId }), {
      status: 'invalid',
      error: 'invalid_transcript_confirmation',
    });
  });

  it('revalidates private artifacts through the configured resolver and rejects artifact drift', async () => {
    const message = ownerMessage('message-artifact-confirmation', '是的，记录内容准确');
    let artifact = { digest: digestPersonMemorySourceMaterial('artifact-v1'), boundedText: '黄挺的人物事实' };
    const resolver = new PersonMemorySourceBundleResolver({
      messageStore: { getById: async () => message },
      ownerPrivateArtifactResolver: { resolve: async () => artifact },
    });
    const bundle = await resolvedBundle(resolver, {
      kind: 'owner_private_artifact',
      artifactLocator: 'workspace:people/huang-ting',
      expectedDigest: artifact.digest,
      boundedExcerpt: '人物事实',
      confirmationMessageId: message.id,
    });
    assert.equal((await resolver.revalidateResolvedBundle(bundle, { ownerUserId })).status, 'resolved');
    artifact = { digest: digestPersonMemorySourceMaterial('artifact-v2'), boundedText: '黄挺的人物事实' };
    assert.deepEqual(await resolver.revalidateResolvedBundle(bundle, { ownerUserId }), {
      status: 'invalid',
      error: 'source_drift',
    });
    assert.deepEqual(await resolver.revalidateResolvedBundle(bundle, { ownerUserId: 'other-owner' }), {
      status: 'invalid',
      error: 'invalid_source_owner',
    });
  });
});
