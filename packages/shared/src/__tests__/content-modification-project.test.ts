import { describe, expect, it } from 'vitest';
import { contentModificationRequestContractSchema } from '../types/content-modification.js';

const digest = `sha256:${'a'.repeat(64)}`;
function request() {
  return {
    operationId: '11111111-1111-4111-8111-111111111111',
    threadId: 'thread-1',
    targetCatId: 'sol',
    source: {
      kind: 'video-project',
      contentRef: 'project-1',
      reviewId: 'review-1',
      expectedReviewRevision: 2,
      screeningId: 'screening-1',
      input: { contentRef: 'project-1', ownerRevision: 1, blobDigest: digest },
      media: { contentRef: 'media-1', ownerRevision: 1, blobDigest: digest },
      annotationIds: ['annotation-1'],
    },
    intent: {
      body: 'Fix the selected moment',
      selections: [
        {
          id: 'selection-1',
          selection: {
            kind: 'video-project',
            baseOwnerRevision: 1,
            baseRevision: digest,
            target: { kind: 'moment', tick: 20, endTick: 40, timebase: { numerator: 1, denominator: 30 } },
          },
        },
      ],
    },
  };
}

describe('F326 canonical F309 project takeover contract', () => {
  it('preserves a project source and its frozen project selection independently of encoded media', () => {
    const value = request();
    expect(contentModificationRequestContractSchema.safeParse(value).success).toBe(true);
    expect(contentModificationRequestContractSchema.parse(value)).toEqual(value);
  });
  it('rejects another project input, wrong anchor revision and unbound selection kinds', () => {
    const otherProject = request();
    otherProject.source.input.contentRef = 'other-project';
    expect(contentModificationRequestContractSchema.safeParse(otherProject).success).toBe(false);
    const stale = request();
    const staleSelection = stale.intent.selections[0];
    if (!staleSelection) throw new Error('Fixture selection absent');
    staleSelection.selection.baseOwnerRevision = 2;
    expect(contentModificationRequestContractSchema.safeParse(stale).success).toBe(false);
    const wrong = request();
    const wrongSelection = wrong.intent.selections[0];
    if (!wrongSelection) throw new Error('Fixture selection absent');
    wrongSelection.selection.baseRevision = `sha256:${'b'.repeat(64)}`;
    expect(contentModificationRequestContractSchema.safeParse(wrong).success).toBe(false);
    const missing = request();
    missing.intent.selections = [];
    expect(contentModificationRequestContractSchema.safeParse(missing).success).toBe(false);
  });
  it('retains full project opinions while legacy text and media keep their 4000-character limit', () => {
    const project = request();
    project.intent.body = 'x'.repeat(8000);
    expect(contentModificationRequestContractSchema.safeParse(project).success).toBe(true);
    const media = {
      ...project,
      source: {
        kind: 'publication',
        contentRef: 'media-1',
        ownerRevision: 1,
        ledgerRef: 'media-review',
        expectedLedgerRevision: 1,
      },
      intent: { body: 'x'.repeat(4001) },
    };
    expect(contentModificationRequestContractSchema.safeParse(media).success).toBe(false);
    const text = {
      ...project,
      source: {
        kind: 'workspace',
        reviewId: 'text-review',
        locator: { worktreeId: 'root', path: 'note.md' },
        expectedSourceRevision: digest,
        expectedReviewRevision: 1,
      },
      intent: { body: 'x'.repeat(4001) },
    };
    expect(contentModificationRequestContractSchema.safeParse(text).success).toBe(false);
  });
});
