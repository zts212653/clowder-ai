import type { WorkVideoContext } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { matchVideoChapters, matchVideoStory } from '../video-work-alignment';

type Story = WorkVideoContext['story'][number];
const row = (id: string, startPts: number, sourceId?: string): Story => ({
  id,
  title: '重复句也可能是不同段落',
  streamId: 'video',
  startPts,
  endPts: startPts + 100,
  ...(sourceId ? { sourceId } : {}),
});

describe('exact video story alignment', () => {
  it('uses explicit source identity across reordered IDs and independent clocks', () => {
    const left = row('v1-second', 400, 'script#paragraph-two');
    const right = row('v4-first', 19000, 'script#paragraph-two');
    expect(matchVideoStory([left], [right])).toEqual([{ sourceId: 'script#paragraph-two', left, right }]);
  });
  it('does not infer identity from the same ID, title or absolute time', () => {
    expect(matchVideoStory([row('same', 10)], [row('same', 10)])).toEqual([]);
    expect(matchVideoStory([row('same', 10, 'source#a')], [row('same', 10, 'source#b')])).toEqual([]);
  });
  it('rejects ambiguous source identity on either side while retaining unambiguous matches', () => {
    const goodLeft = row('a', 0, 'good'),
      goodRight = row('b', 9, 'good');
    expect(
      matchVideoStory(
        [goodLeft, row('c', 0, 'duplicate'), row('d', 1, 'duplicate')],
        [goodRight, row('e', 2, 'duplicate')],
      ),
    ).toEqual([{ sourceId: 'good', left: goodLeft, right: goodRight }]);
    expect(matchVideoStory([row('a', 1, 'x')], [row('b', 2, 'x'), row('c', 3, 'x')])).toEqual([]);
  });
});

it('aligns explicit chapter lineage using each frozen version clock without guessing titles', () => {
  const left = { ...row('old-chapter', 3500, 'film:chapter:ending'), label: '终章' };
  const right = { ...row('new-chapter', 96000, 'film:chapter:ending'), label: '终章' };
  expect(matchVideoChapters([left], [right])).toEqual([{ sourceId: 'film:chapter:ending', left, right }]);
  expect(matchVideoChapters([row('c0', 0)], [row('c0', 0)])).toEqual([]);
});
