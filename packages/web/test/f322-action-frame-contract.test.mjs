import assert from 'node:assert/strict';
import test from 'node:test';
import { assertActionFrame } from './browser/f322-action-frame-contract.mjs';

const translatedFrame = {
  viewport: 1440,
  rowClient: 720,
  rowScroll: 720,
  portClient: 1144,
  portScroll: 1144,
  slotWidth: 0,
  slotHeight: 0,
  visibility: 'hidden',
  inert: true,
  controls: [
    {
      left: 386,
      right: 430,
      columnLeft: 508,
      columnRight: 1228,
      portLeft: 296,
      portRight: 1440,
      top: 366,
      bottom: 410,
      portTop: 53,
      portBottom: 886,
    },
  ],
};
const pending = {
  ...translatedFrame,
  ready: 'false',
  committedEpoch: null,
  latestEpoch: '4',
  ariaHidden: 'true',
  activeDescendant: false,
};

test('the original hidden/inert translation frame lacks pending authority', () => {
  assert.throws(() => assertActionFrame(translatedFrame, 'original'));
});
test('only the complete explicit pending state can retain temporary old geometry', () => {
  assert.doesNotThrow(() => assertActionFrame(pending, 'complete pending'));
  for (const mutation of [
    { ready: 'true' },
    { ariaHidden: 'false' },
    { activeDescendant: true },
    { inert: false },
    { latestEpoch: undefined },
    { committedEpoch: '4' },
    { visibility: 'visible' },
  ]) {
    assert.throws(() => assertActionFrame({ ...pending, ...mutation }, 'missing proof'));
  }
});
test('opacity-zero visible and stale committed controls cannot borrow a pending exception', () => {
  assert.throws(() =>
    assertActionFrame(
      { ...pending, ready: 'true', committedEpoch: '4', visibility: 'visible', opacity: 0 },
      'prepaint',
    ),
  );
  const contained = { ...pending.controls[0], left: 682, right: 870 };
  assert.throws(() =>
    assertActionFrame(
      { ...pending, controls: [contained], ready: 'true', committedEpoch: '3', visibility: 'visible' },
      'stale commit',
    ),
  );
  assert.doesNotThrow(() =>
    assertActionFrame(
      { ...pending, controls: [contained], ready: 'true', committedEpoch: '4', visibility: 'visible' },
      'live commit',
    ),
  );
});

test('expanded menu extent is checked even when the collapsed toolbar is contained', () => {
  const toolbar = { ...pending.controls[0], left: 682, right: 870, top: 852, bottom: 886 };
  const frame = { ...pending, ready: 'true', committedEpoch: '4', visibility: 'visible', controls: [toolbar] };
  assert.doesNotThrow(() => assertActionFrame(frame, 'toolbar'));
  assert.throws(() =>
    assertActionFrame({ ...frame, controls: [toolbar, { ...toolbar, top: 887, bottom: 1038 }] }, 'expanded More'),
  );
});

test('unavailable derived sheets cannot borrow the trigger plane fail-closed state', () => {
  const surface = {
    state: 'unavailable',
    visibility: 'hidden',
    inert: true,
    ariaHidden: 'true',
    activeDescendant: false,
  };
  assert.doesNotThrow(() => assertActionFrame({ ...pending, surfaces: [surface] }, 'closed sheet'));
  for (const mutation of [
    { visibility: 'visible' },
    { inert: false },
    { ariaHidden: 'false' },
    { activeDescendant: true },
  ])
    assert.throws(() => assertActionFrame({ ...pending, surfaces: [{ ...surface, ...mutation }] }, 'leaked sheet'));
});
