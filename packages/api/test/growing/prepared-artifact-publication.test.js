import assert from 'node:assert/strict';
import { test } from 'node:test';

const { F232PreparedArtifactReader } = await import('../../dist/domains/growing/F232PreparedArtifactReader.js');

const input = {
  artifactRef: '/uploads/prepared.pptx',
  taskThreadId: 'thread-prepared',
  taskSubjectRef: 'task:work:ppt',
  taskOwnerRef: 'task:item:ppt',
  taskRevision: 3,
  ownerUserId: 'owner-1',
};
const publication = {
  id: 'published-file',
  threadId: 'thread-prepared',
  userId: 'owner-1',
  catId: 'codex-sol',
  timestamp: 700,
  content: 'Prepared for review',
  extra: {
    rich: {
      blocks: [
        {
          kind: 'file',
          id: 'file-1',
          v: 1,
          fileName: 'prepared.pptx',
          url: '/uploads/prepared.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        },
      ],
    },
  },
};
function reader(messages) {
  return new F232PreparedArtifactReader({
    messages: {
      async getByThread() {
        return messages;
      },
      async getByThreadBefore() {
        return [];
      },
    },
    tasks: {
      async listByThread() {
        return [];
      },
    },
    threads: {
      async getThreadMemory() {
        return {
          recentArtifacts: [
            { type: 'file', ref: input.artifactRef, label: 'Found on disk', updatedAt: 900, updatedBy: 'codex-sol' },
          ],
        };
      },
    },
  });
}
test('a file-ledger entry without a published Artifact is not prepared work', async () => {
  assert.equal(await reader([]).readPreparedArtifact(input), null);
});
test('prepared work binds to a published owner Artifact even when file-ledger metadata is newer', async () => {
  const result = await reader([publication]).readPreparedArtifact(input);
  assert.equal(result.artifactRevision, '700');
  assert.equal(result.completenessRef, 'message:thread-prepared:published-file#available:700');
  assert.equal(result.openInWorkspaceRef, 'workspace:artifact:thread-prepared:700:/uploads/prepared.pptx');
});
test('recalled, tombstoned, canceled and unpublished stream outputs cannot certify prepared content', async () => {
  for (const patch of [
    { recall: true },
    { _tombstone: true },
    { deliveryStatus: 'canceled' },
    { deliveryStatus: 'queued', origin: 'stream' },
    { userId: 'other-owner' },
    { threadId: 'other-thread' },
  ]) {
    assert.equal(await reader([{ ...publication, ...patch }]).readPreparedArtifact(input), null);
  }
});
