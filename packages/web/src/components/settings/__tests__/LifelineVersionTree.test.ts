import type { VersionEpoch } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { flattenVersionTree } from '../LifelineVersionTree';

function epoch(version: number, parentVersion: number | null): VersionEpoch {
  return {
    version,
    parentVersion,
    origin: 'manifest',
    startedAt: version,
    status: 'idle',
    isActive: false,
    tracing: null,
    eval: null,
    governance: null,
    events: [],
  };
}

describe('flattenVersionTree', () => {
  it('keeps ancestor rails open until every later sibling branch is rendered', () => {
    const rows = flattenVersionTree([epoch(1, null), epoch(2, 1), epoch(3, 2), epoch(4, 2), epoch(5, 3), epoch(6, 1)]);

    expect(
      rows.map(({ epoch: item, depth, parentVersion, isLastSibling, hasChildren, ancestorContinuations }) => ({
        version: item.version,
        depth,
        parentVersion,
        isLastSibling,
        hasChildren,
        ancestorContinuations,
      })),
    ).toEqual([
      {
        version: 1,
        depth: 0,
        parentVersion: null,
        isLastSibling: true,
        hasChildren: true,
        ancestorContinuations: [],
      },
      {
        version: 2,
        depth: 1,
        parentVersion: 1,
        isLastSibling: false,
        hasChildren: true,
        ancestorContinuations: [],
      },
      {
        version: 3,
        depth: 2,
        parentVersion: 2,
        isLastSibling: false,
        hasChildren: true,
        ancestorContinuations: [true],
      },
      {
        version: 5,
        depth: 3,
        parentVersion: 3,
        isLastSibling: true,
        hasChildren: false,
        ancestorContinuations: [true, true],
      },
      {
        version: 4,
        depth: 2,
        parentVersion: 2,
        isLastSibling: true,
        hasChildren: false,
        ancestorContinuations: [true],
      },
      {
        version: 6,
        depth: 1,
        parentVersion: 1,
        isLastSibling: true,
        hasChildren: false,
        ancestorContinuations: [],
      },
    ]);
  });
});
