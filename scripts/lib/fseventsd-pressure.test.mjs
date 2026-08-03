import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fseventsdAdvisoryRssKb } from './fseventsd-pressure.mjs';

const GIB_IN_KB = 1024 * 1024;

describe('fseventsd pressure thresholds', () => {
  it('scales the advisory threshold down on smaller machines', () => {
    assert.equal(fseventsdAdvisoryRssKb(4 * GIB_IN_KB, 16 * GIB_IN_KB), Math.floor(1.6 * GIB_IN_KB));
  });

  it('retains the 4 GiB advisory ceiling on high-memory machines', () => {
    assert.equal(fseventsdAdvisoryRssKb(4 * GIB_IN_KB, 128 * GIB_IN_KB), 4 * GIB_IN_KB);
  });
});
