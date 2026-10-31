import { describe, expect, it } from 'vitest';
import { contentReviewCapabilities } from '../content-review-capabilities';
import type { ContentReviewView } from '../content-review-contract';
import { workspaceReviewRequestSource } from '../workspace-modification-source';

const view: ContentReviewView = {
  review: {
    reviewId: 'review',
    ownerUserId: 'operator',
    contentRef: 'video-project:test',
    revision: 1,
    source: {
      kind: 'video-project',
      contentRef: 'video-project:test',
      ownerRevision: 1,
      revision: `sha256:${'a'.repeat(64)}`,
      mime: 'application/vnd.cat-cafe.video-project+json',
    },
    annotations: [],
  },
  sourceState: 'current',
  canWrite: true,
  canReply: true,
  annotationResolutions: [],
};

describe('legacy workspace content consumers preserve the project boundary', () => {
  it('does not offer text/media editing on a project JSON source', () => {
    const capabilities = contentReviewCapabilities(view);
    expect(capabilities.requestModification).toMatchObject({ state: 'unavailable', medium: 'project' });
    for (const key of ['annotate', 'reply', 'markup', 'versions', 'decide'] as const)
      expect(capabilities[key].state).toBe('unavailable');
  });
  it('does not invent a workspace locator for a project source', () => {
    expect(() => workspaceReviewRequestSource(view)).toThrow('project service');
  });
});
