import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareWorkResultFilePublication, WorkResultFilePublicationError } from '../work-result-publication.js';

const bytes = Buffer.from('# Exact result\n');
const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fileName = `cwork-${contentDigest.slice('sha256:'.length)}.md`;
const sourceHref = `/uploads/${fileName}`;
const artifactSnapshot = {
  taskRef: 'task:task-one',
  taskRevision: 1,
  artifactRef: sourceHref,
  artifactRevision: '1',
  completenessRef: 'message:thread:message-one#available:1',
  previewRef: 'message:thread:message-one#preview:1',
  openInWorkspaceRef: 'workspace:artifact:thread:1:result',
  textPublication: {
    v: 1 as const,
    taskId: 'task-one',
    resultRevision: 1,
    executionRevision: 1,
    sourceMessageId: 'message-one',
    sourceMessageRevision: '1',
    triggerMessageId: 'trigger-one',
    publisherCatId: 'codex-sol',
    invocationId: 'invocation-one',
    item: { kind: 'rich-file' as const, blockId: 'file-one' },
    contentDigest,
    byteLength: bytes.length,
    mediaType: 'text/markdown' as const,
  },
};
const source = {
  v: 1 as const,
  sourceHref,
  fileName,
  mediaType: 'text/markdown' as const,
  contentDigest,
  byteLength: bytes.length,
  contentBase64: bytes.toString('base64'),
};

describe('Work result file publication', () => {
  it('leaves an unlinked sealed result compatible instead of creating an unreachable attachment', () => {
    expect(
      prepareWorkResultFilePublication({
        outboxId: 'outbox_one',
        serviceUrl: 'https://collective.example',
        body: 'The registered result is ready.',
        artifactSnapshot,
        source,
      }),
    ).toEqual({ body: 'The registered result is ready.' });
  });

  it('refuses a linked sealed result when its exact bytes are missing', () => {
    expect(() =>
      prepareWorkResultFilePublication({
        outboxId: 'outbox_one',
        serviceUrl: 'https://collective.example',
        body: `Open it: [result](${sourceHref})`,
        artifactSnapshot,
      }),
    ).toThrow(WorkResultFilePublicationError);
  });
});
