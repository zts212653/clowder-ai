import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { allProcessesGone, isSelfOrDescendantOf, parentOf } from './process-tree.mjs';

/**
 * F300 -- three-valued observation of the process tree.
 *
 * Every input here is a fixture or an injected read boundary. Nothing in this
 * file signals, spawns or stops a real process.
 */

/** Stands in for `ps -p <pid> -o ppid=`: a map of pid -> printed field. */
function psReader(table) {
  return (pid) => {
    if (!(pid in table)) throw new Error(`ps: no such process ${pid}`);
    return table[pid];
  };
}

describe('parentOf: reading a boundary is not failing to read', () => {
  it('reports an observed ppid of 0 as the root boundary it is', () => {
    // launchd (and pid 1 itself) print ppid 0. Folding that into `undefined`
    // makes a legitimate top-of-tree indistinguishable from an unreadable one.
    assert.equal(parentOf(1, psReader({ 1: '0' })), 0);
  });

  it('reports an ordinary parent', () => {
    assert.equal(parentOf(4242, psReader({ 4242: '1' })), 1);
  });

  it('cannot tell when the read itself fails', () => {
    assert.equal(parentOf(4242, psReader({})), undefined);
  });

  it('cannot tell when ps prints nothing', () => {
    assert.equal(parentOf(4242, psReader({ 4242: '' })), undefined);
  });
});

describe('isSelfOrDescendantOf: root boundaries end the walk', () => {
  const withReads = (table) => ({ readField: psReader(table) });

  it('answers no when the chain reaches an observed ppid of 0', () => {
    // 9999 -> 500 -> 1 -> 0. None of those is the launcher, and the chain is
    // fully read, so the honest answer is a definite no.
    const table = { 9999: '500', 500: '1', 1: '0' };
    assert.equal(isSelfOrDescendantOf(9999, 4242, withReads(table)), false);
  });

  it('still answers unknown when a link cannot be read', () => {
    assert.equal(isSelfOrDescendantOf(9999, 4242, withReads({ 9999: '500' })), undefined);
  });

  it('answers yes when the launcher is on the chain', () => {
    const table = { 9999: '500', 500: '4242', 4242: '1', 1: '0' };
    assert.equal(isSelfOrDescendantOf(9999, 4242, withReads(table)), true);
  });

  it('answers yes for the launcher itself without reading anything', () => {
    assert.equal(isSelfOrDescendantOf(4242, 4242, withReads({})), true);
  });
});

describe('allProcessesGone: unknown never collapses into gone', () => {
  it('is unknown when any pid cannot be observed', () => {
    assert.equal(allProcessesGone([Number.NaN]), undefined);
  });

  it('is gone for an empty set', () => {
    assert.equal(allProcessesGone([]), true);
  });
});
