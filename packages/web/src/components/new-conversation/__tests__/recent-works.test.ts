import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { projectRecentWorks } from '../recent-works';

function artifact(overrides: Partial<GlobalArtifactDTO> = {}): GlobalArtifactDTO {
  return {
    type: 'image',
    name: 'work',
    catId: 'codex-sol',
    createdAt: 10,
    sourceMessageId: 'message-a',
    url: '/uploads/work.png',
    publicationItem: { kind: 'content-block', index: 0 },
    threadId: 'thread-a',
    threadTitle: 'Thread A',
    ...overrides,
  };
}

describe('F322 recent works projection', () => {
  it('admits only cat-authored image, video and non-ledger files', () => {
    const visible = projectRecentWorks(
      [
        artifact({ name: 'human upload', catId: null }),
        artifact({ name: 'code', type: 'code' }),
        artifact({ name: 'audio', type: 'audio' }),
        artifact({ name: 'widget', type: 'widget' }),
        artifact({ name: 'workspace file', type: 'file', fileLedgerRef: 'ledger:1' }),
        artifact({ name: 'image' }),
        artifact({ name: 'video', type: 'video' }),
        artifact({ name: 'published file', type: 'file' }),
      ],
      'unavailable',
    );

    expect(visible.map((item) => item.name).sort()).toEqual(['image', 'published file', 'video']);
  });

  it('uses the accepted deterministic tie order and never guesses a family from the name', () => {
    const visible = projectRecentWorks(
      [
        artifact({ threadId: 'thread-b', sourceMessageId: 'message-a', name: 'same name' }),
        artifact({ threadId: 'thread-a', sourceMessageId: 'message-b', name: 'same name' }),
        artifact({
          threadId: 'thread-a',
          sourceMessageId: 'message-a',
          name: 'same name',
          publicationItem: { kind: 'content-block', index: 1 },
        }),
        artifact({
          threadId: 'thread-a',
          sourceMessageId: 'message-a',
          name: 'same name',
          publicationItem: { kind: 'content-block', index: 0 },
        }),
      ],
      'unavailable',
      10,
    );

    expect(visible).toHaveLength(4);
    expect(visible.map((item) => [item.threadId, item.sourceMessageId, item.publicationItem])).toEqual([
      ['thread-a', 'message-a', { kind: 'content-block', index: 0 }],
      ['thread-a', 'message-a', { kind: 'content-block', index: 1 }],
      ['thread-a', 'message-b', { kind: 'content-block', index: 0 }],
      ['thread-b', 'message-a', { kind: 'content-block', index: 0 }],
    ]);
  });

  it('orders records with no exact publication item deterministically without merging them', () => {
    const visible = projectRecentWorks(
      [
        artifact({ name: 'Zulu', publicationItem: undefined, url: '/uploads/z.png' }),
        artifact({ name: 'Alpha', publicationItem: undefined, url: '/uploads/a.png' }),
      ],
      'unavailable',
      10,
    );

    expect(visible.map((item) => item.name)).toEqual(['Alpha', 'Zulu']);
  });

  it('keeps only the greatest owner revision for a resolved work coordinate', () => {
    const visible = projectRecentWorks(
      [
        artifact({
          name: 'revision one but newer publication',
          createdAt: 30,
          work: { contentRef: 'work:one', ownerRevision: 1, currentOwnerRevision: 2 },
        }),
        artifact({
          name: 'revision two',
          createdAt: 20,
          work: { contentRef: 'work:one', ownerRevision: 2, currentOwnerRevision: 2 },
        }),
      ],
      'resolved',
      10,
    );

    expect(visible.map((item) => item.name)).toEqual(['revision two']);
  });

  it('uses the accepted deterministic ordering to break a same-work revision tie', () => {
    const visible = projectRecentWorks(
      [
        artifact({
          name: 'older deterministic loser',
          createdAt: 20,
          threadId: 'thread-b',
          work: { contentRef: 'work:one', ownerRevision: 2, currentOwnerRevision: 2 },
        }),
        artifact({
          name: 'newer deterministic winner',
          createdAt: 30,
          threadId: 'thread-a',
          work: { contentRef: 'work:one', ownerRevision: 2, currentOwnerRevision: 2 },
        }),
      ],
      'resolved',
      10,
    );

    expect(visible.map((item) => item.name)).toEqual(['newer deterministic winner']);
  });

  it('keeps no-work publications separate even when lineage is resolved', () => {
    const visible = projectRecentWorks(
      [
        artifact({ name: 'first no-work publication', createdAt: 30 }),
        artifact({ name: 'second no-work publication', createdAt: 20 }),
      ],
      'resolved',
      10,
    );

    expect(visible.map((item) => item.name)).toEqual(['first no-work publication', 'second no-work publication']);
  });

  it('does not deduplicate work-shaped records when lineage is unavailable', () => {
    const visible = projectRecentWorks(
      [
        artifact({
          name: 'revision two',
          createdAt: 20,
          work: { contentRef: 'work:one', ownerRevision: 2, currentOwnerRevision: 2 },
        }),
        artifact({
          name: 'revision one',
          createdAt: 10,
          work: { contentRef: 'work:one', ownerRevision: 1, currentOwnerRevision: 2 },
        }),
      ],
      'unavailable',
      10,
    );

    expect(visible.map((item) => item.name)).toEqual(['revision two', 'revision one']);
  });

  it('keeps an honestly stale current-owner revision visible without inventing a latest claim', () => {
    const visible = projectRecentWorks(
      [
        artifact({
          name: 'stale but exact publication',
          work: { contentRef: 'work:one', ownerRevision: 2, currentOwnerRevision: 3 },
        }),
      ],
      'resolved',
      10,
    );

    expect(visible).toHaveLength(1);
    expect(visible[0]?.work).toEqual({ contentRef: 'work:one', ownerRevision: 2, currentOwnerRevision: 3 });
  });

  it('applies the card limit only after resolved works have been projected', () => {
    const visible = projectRecentWorks(
      [
        artifact({
          name: 'old revision',
          createdAt: 40,
          work: { contentRef: 'work:one', ownerRevision: 1, currentOwnerRevision: 2 },
        }),
        artifact({
          name: 'current revision',
          createdAt: 30,
          work: { contentRef: 'work:one', ownerRevision: 2, currentOwnerRevision: 2 },
        }),
        artifact({ name: 'independent publication', createdAt: 20 }),
      ],
      'resolved',
      2,
    );

    expect(visible.map((item) => item.name)).toEqual(['current revision', 'independent publication']);
  });
});
