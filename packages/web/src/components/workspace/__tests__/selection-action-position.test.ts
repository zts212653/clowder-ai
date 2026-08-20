import { describe, expect, it } from 'vitest';
import {
  positionSelectionAction,
  positionSelectionActionForAnchors,
  selectionAnchorPositions,
  selectionAnchorPositionsForRows,
  selectionOffsetInRange,
} from '../selection-action-position';

const viewport = {
  top: 100,
  right: 700,
  bottom: 600,
  left: 200,
  width: 500,
  height: 500,
};

describe('positionSelectionAction', () => {
  it('anchors the action beside the visible selection instead of the viewer origin', () => {
    const position = positionSelectionAction(
      { top: 300, right: 450, bottom: 320, left: 400, width: 50, height: 20 },
      viewport,
    );

    expect(position).toEqual({ top: 160, left: 138 });
  });

  it('moves when the selected text moves in the viewport', () => {
    const before = positionSelectionAction(
      { top: 300, right: 450, bottom: 320, left: 400, width: 50, height: 20 },
      viewport,
    );
    const after = positionSelectionAction(
      { top: 420, right: 450, bottom: 440, left: 400, width: 50, height: 20 },
      viewport,
    );

    expect(after?.top).toBe((before?.top ?? 0) + 120);
  });

  it('places the action below a selection when there is no room above', () => {
    const position = positionSelectionAction(
      { top: 106, right: 450, bottom: 126, left: 400, width: 50, height: 20 },
      viewport,
    );

    expect(position).toEqual({ top: 34, left: 138 });
  });

  it('hides the action when the selection is outside the scroll viewport', () => {
    expect(
      positionSelectionAction({ top: 40, right: 450, bottom: 80, left: 400, width: 50, height: 40 }, viewport),
    ).toBeNull();
  });

  it('anchors to another selected fragment when the preferred fragment is off-screen', () => {
    const position = positionSelectionActionForAnchors(
      [
        { top: 700, right: 450, bottom: 720, left: 400, width: 50, height: 20 },
        { top: 420, right: 450, bottom: 440, left: 400, width: 50, height: 20 },
      ],
      viewport,
    );

    expect(position).toEqual({ top: 280, left: 138 });
  });

  it('adds an anchor inside the visible intersection of a long editor selection', () => {
    expect(
      selectionAnchorPositions({ from: 10, to: 1000, head: 1000 }, [
        { from: 200, to: 300 },
        { from: 500, to: 600 },
      ]),
    ).toEqual([1000, 599, 299]);
  });

  it('chooses a selected offset inside the horizontally visible part of one rendered line', () => {
    expect(selectionOffsetInRange({ from: 10, to: 1000, head: 1000 }, { from: 200, to: 300 })).toBe(299);
  });

  it('enumerates every selected viewport row when one visible range spans multiple lines', () => {
    const rows = [
      { from: 10, to: 100 },
      { from: 101, to: 200 },
      { from: 201, to: 300 },
    ];

    expect(selectionAnchorPositionsForRows({ from: 10, to: 1000, head: 10 }, rows)).toEqual([10, 101, 201]);
    expect(selectionAnchorPositionsForRows({ from: 10, to: 1000, head: 1000 }, rows)).toEqual([1000, 299, 199, 99]);
  });
});
