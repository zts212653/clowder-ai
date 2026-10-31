import type { ArtifactReviewAnchor } from '@cat-cafe/shared';
import { describe, expect, it, vi } from 'vitest';

// The combined-words rule is the canonical `contentModificationOutcome`. Only its own length error means "too long";
// any other failure is something this code did not expect and must surface, never be folded into a refusal as if it
// were a verdict about the person's words.
vi.mock('@cat-cafe/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cat-cafe/shared')>()),
  contentModificationOutcome: () => {
    throw new Error('something unexpected');
  },
}));

import { addMediaSelection } from '../media-chat-selection';

const SOURCE = {
  kind: 'workspace',
  locator: { worktreeId: 'wt-1', path: 'art/cover.png' },
  expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
  reviewId: 'review-1',
  expectedReviewRevision: 3,
} as const;
const REGION: ArtifactReviewAnchor = { kind: 'image-region', x: 1, y: 2, width: 3, height: 4 };

describe('addMediaSelection — an unexpected failure of the combined-words rule', () => {
  it('is not turned into a "too long" verdict', () => {
    const target = { title: 'cover.png', mediaType: 'image/png', source: SOURCE } as const;
    expect(() => addMediaSelection([], target, REGION, '说明')).toThrow('something unexpected');
  });

  it('is never consulted when no place has any words, so a place without words cannot trip it', () => {
    const target = { title: 'cover.png', mediaType: 'image/png', source: SOURCE } as const;
    expect(addMediaSelection([], target, REGION).kind).toBe('added');
  });
});
