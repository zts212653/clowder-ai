import { expect, it } from 'vitest';
import {
  addMarkupMark,
  emptyMarkupHistory,
  type ReviewMarkupMark,
  redoMarkup,
  removeMarkupMark,
  undoMarkup,
} from '../review-markup-draft';

const media = { kind: 'image' as const, width: 100, height: 60 };
const rectangle: ReviewMarkupMark = {
  id: 'rectangle',
  kind: 'rectangle',
  x: 10,
  y: 12,
  width: 30,
  height: 20,
  color: '#d04a3a',
  strokeWidth: 4,
};

it('keeps local marks bounded and gives add, undo, redo, and erase distinct behavior', () => {
  const added = addMarkupMark(emptyMarkupHistory(), rectangle, media);
  expect(added.current).toEqual([rectangle]);
  const undone = undoMarkup(added);
  expect(undone.current).toEqual([]);
  expect(redoMarkup(undone).current).toEqual([rectangle]);
  expect(removeMarkupMark(added, rectangle.id).current).toEqual([]);
});

it('refuses uncontrolled or out-of-media drawing data before it reaches the local draft', () => {
  const unknownColor = { ...rectangle, id: 'untrusted', color: '#ffffff' } as unknown as ReviewMarkupMark;
  const outOfBounds = { ...rectangle, id: 'outside', x: 90, width: 20 };
  const invalidStroke = {
    id: 'invalid-stroke',
    kind: 'stroke',
    points: [{ x: 5, y: 5 }],
    color: '#3478c7',
    strokeWidth: 2,
  } as ReviewMarkupMark;
  for (const mark of [unknownColor, outOfBounds, invalidStroke])
    expect(addMarkupMark(emptyMarkupHistory(), mark, media)).toEqual(emptyMarkupHistory());
});
