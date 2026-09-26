/**
 * Unit tests for desktop/port-pair.js.
 *
 * The invariant under test is not "find a free port" but "Web and API ports
 * stay adjacent": packages/web derives its API base as `location.port + 1`, so
 * a pair that drifts apart loads the UI and then fails every request.
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  API_PORT_OFFSET,
  DEFAULT_FRONTEND_PORT,
  MAX_PORT,
  createPortPair,
  isSamePair,
  isValidPortPair,
  normalizeRememberedPair,
  portPairCandidates,
} = require('./port-pair');

describe('port-pair: the adjacency invariant', () => {
  it('puts the API one above the frontend', () => {
    assert.deepEqual(createPortPair(3003), { frontend: 3003, api: 3004 });
    assert.equal(API_PORT_OFFSET, 1);
    assert.equal(DEFAULT_FRONTEND_PORT, 3003);
  });

  it('accepts a well-formed pair', () => {
    assert.equal(isValidPortPair({ frontend: 3003, api: 3004 }), true);
    assert.equal(isValidPortPair({ frontend: 1, api: 2 }), true);
  });

  it('rejects a pair whose ports drifted apart', () => {
    assert.equal(isValidPortPair({ frontend: 3003, api: 3005 }), false);
    assert.equal(isValidPortPair({ frontend: 3003, api: 3003 }), false);
    assert.equal(isValidPortPair({ frontend: 3004, api: 3003 }), false);
  });

  it('rejects unusable port numbers', () => {
    assert.equal(isValidPortPair({ frontend: 0, api: 1 }), false);
    assert.equal(isValidPortPair({ frontend: -1, api: 0 }), false);
    assert.equal(isValidPortPair({ frontend: 3003.5, api: 3004.5 }), false);
    assert.equal(isValidPortPair({ frontend: '3003', api: '3004' }), false);
    assert.equal(isValidPortPair(null), false);
    assert.equal(isValidPortPair(undefined), false);
  });

  it('rejects a pair that would run past the port ceiling', () => {
    assert.equal(isValidPortPair({ frontend: MAX_PORT, api: MAX_PORT + 1 }), false);
  });
});

describe('port-pair: candidate list', () => {
  it('starts at the default and walks upward', () => {
    const pairs = portPairCandidates({ attempts: 4 });

    assert.deepEqual(pairs, [
      { frontend: 3003, api: 3004 },
      { frontend: 3004, api: 3005 },
      { frontend: 3005, api: 3006 },
      { frontend: 3006, api: 3007 },
    ]);
  });

  it('honours a custom base', () => {
    assert.deepEqual(portPairCandidates({ base: 4104, attempts: 2 }), [
      { frontend: 4104, api: 4105 },
      { frontend: 4105, api: 4106 },
    ]);
  });

  it('never emits a pair past the ceiling', () => {
    const pairs = portPairCandidates({ base: MAX_PORT - 1, attempts: 5 });

    assert.deepEqual(pairs, [{ frontend: MAX_PORT - 1, api: MAX_PORT }]);
    for (const pair of pairs) assert.equal(isValidPortPair(pair), true);
  });

  it('emits only valid pairs for the defaults', () => {
    for (const pair of portPairCandidates()) assert.equal(isValidPortPair(pair), true);
  });
});

describe('port-pair: remembered pairs', () => {
  it('accepts a valid remembered pair', () => {
    assert.deepEqual(normalizeRememberedPair({ frontendPort: 4104, apiPort: 4105 }), {
      frontend: 4104,
      api: 4105,
    });
  });

  it('ignores a missing, partial or drifted remembered pair', () => {
    assert.equal(normalizeRememberedPair(null), null);
    assert.equal(normalizeRememberedPair({}), null);
    assert.equal(normalizeRememberedPair({ frontendPort: 4104 }), null);
    assert.equal(normalizeRememberedPair({ frontendPort: 4104, apiPort: 4106 }), null);
  });

  it('ignores a record from an older build that only stored redisPort', () => {
    assert.equal(normalizeRememberedPair({ instanceId: 'x', redisPort: 6399 }), null);
  });
});

describe('port-pair: comparison', () => {
  it('compares both members', () => {
    assert.equal(isSamePair({ frontend: 1, api: 2 }, { frontend: 1, api: 2 }), true);
    assert.equal(isSamePair({ frontend: 1, api: 2 }, { frontend: 1, api: 3 }), false);
    assert.equal(isSamePair(null, { frontend: 1, api: 2 }), false);
  });
});
