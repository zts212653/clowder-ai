import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersonMemoryOwnerSourceReader } from '../dist/domains/memory/people/PersonMemoryOwnerSourceReader.js';
import {
  digestPersonMemorySourceMaterial,
  PersonMemorySourceBundleResolver,
} from '../dist/domains/memory/people/PersonMemorySourceBundleResolver.js';

const owner = 'owner',
  ref = { kind: 'message', threadId: 'synthetic-thread', messageId: 'synthetic-message' };
const attachment = { type: 'text', text: 'private synthetic fact' };
const artifact = {
  digest: digestPersonMemorySourceMaterial('synthetic artifact'),
  boundedText: 'private synthetic fact',
};
const clean = {
  id: ref.messageId,
  threadId: ref.threadId,
  userId: owner,
  catId: null,
  from: { kind: 'user', userId: owner },
  content: '是的，记录内容准确。private synthetic fact',
  timestamp: 1,
  contentBlocks: [attachment],
  deliveryStatus: 'delivered',
};
const inputs = [
  { kind: 'message_text', messageId: ref.messageId, excerpt: 'synthetic fact' },
  {
    kind: 'message_attachment',
    messageId: ref.messageId,
    attachmentLocator: { surface: 'content_block', index: 0 },
    expectedDigest: digestPersonMemorySourceMaterial(attachment),
    boundedTranscript: 'synthetic fact',
  },
  {
    kind: 'owner_confirmed_transcript',
    transcript: 'synthetic fact',
    transcriptDigest: digestPersonMemorySourceMaterial('synthetic fact'),
    confirmationMessageId: ref.messageId,
    confirmationScope: 'transcript_accuracy',
  },
  {
    kind: 'owner_private_artifact',
    artifactLocator: 'workspace:synthetic-fixture',
    expectedDigest: artifact.digest,
    boundedExcerpt: 'synthetic fact',
    confirmationMessageId: ref.messageId,
  },
];
const variants = [
  ['missing', null, 'message_missing'],
  ['deleted', { ...clean, deletedAt: 2 }, 'message_deleted'],
  [
    'non-owner sender',
    { ...clean, catId: 'codex61-terra', from: { kind: 'cat', catId: 'codex61-terra' } },
    'message_not_owner_authored',
  ],
  [
    'foreign owner',
    { ...clean, userId: 'foreign', from: { kind: 'user', userId: 'foreign' } },
    'message_owner_mismatch',
  ],
  ['not delivered', { ...clean, deliveryStatus: 'queued' }, 'message_not_delivered'],
];
async function fixture(input) {
  let current = clean;
  let currentArtifact = artifact;
  const deps = {
    messageStore: { getById: async () => current },
    threadStore: { get: async () => ({ id: ref.threadId, createdBy: owner }), list: async () => [] },
    ownerPrivateArtifactResolver: { resolve: async () => currentArtifact },
  };
  const resolved = await new PersonMemorySourceBundleResolver(deps).resolve(
    {
      sources: [{ sourceId: 'source', ...input }],
      assertionBindings: [{ sourceId: 'source', target: { kind: 'claim', index: 0 }, role: 'reported_fact' }],
    },
    { ownerUserId: owner },
    { claimDraftIds: ['person_draft_synthetic'] },
  );
  assert.equal(resolved.status, 'resolved');
  const item = { ownerUserId: owner, sourceRefs: [ref], typedProvenance: resolved.bundle };
  const reader = new PersonMemoryOwnerSourceReader(deps),
    reasons = [];
  const read = () => reader.read(owner, item, (reason) => reasons.push(reason));
  assert.equal((await read()).status, 'ready');
  assert.deepEqual(reasons, []);
  return {
    read,
    reasons,
    set: (value) => {
      current = value;
    },
    revokeArtifact: () => {
      currentArtifact = null;
    },
  };
}
test('typed attachment reports a removed attachment without exposing its contents', async () => {
  const f = await fixture(inputs[1]);
  f.set({ ...clean, contentBlocks: [] });
  assert.deepEqual(await f.read(), { status: 'unavailable' });
  assert.deepEqual(f.reasons, ['attachment_transcript_mismatch']);
});
test('typed artifact reports an unavailable artifact separately from its owner confirmation', async () => {
  const f = await fixture(inputs[3]);
  f.revokeArtifact();
  assert.deepEqual(await f.read(), { status: 'unavailable' });
  assert.deepEqual(f.reasons, ['invalid_private_artifact']);
});
for (const input of inputs)
  for (const [name, value, reason] of variants) {
    test(`typed ${input.kind}: ${name} remains unavailable with a distinct bounded reason`, async () => {
      const f = await fixture(input);
      f.set(value);
      assert.deepEqual(await f.read(), { status: 'unavailable' });
      assert.deepEqual(f.reasons, [reason]);
    });
  }
for (const input of inputs.filter((input) => input.kind.includes('confirmed') || input.kind.includes('artifact'))) {
  test(`typed ${input.kind}: withdrawal is distinguished from message eligibility`, async () => {
    const f = await fixture(input);
    f.set({ ...clean, content: '不对，内容不准确' });
    assert.deepEqual(await f.read(), { status: 'unavailable' });
    assert.deepEqual(f.reasons, [
      input.kind === 'owner_private_artifact' ? 'invalid_artifact_confirmation' : 'invalid_transcript_confirmation',
    ]);
  });
}
