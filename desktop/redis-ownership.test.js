/**
 * Unit tests for desktop/redis-ownership.js.
 *
 * The decision logic here is what stops the desktop app from attaching to a
 * Redis that belongs to something else (another Clowder instance, a system
 * Redis, or a Clowder server on the same machine).
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  INSTANCE_MARKER_KEY,
  OWNERSHIP,
  encodeCommand,
  evaluateRedisOwnership,
  formatOwnershipRefusal,
  parseReply,
} = require('./redis-ownership');

describe('redis-ownership: RESP encoding', () => {
  it('encodes a command as a RESP array', () => {
    assert.equal(
      encodeCommand(['GET', 'clowder:desktop:instance']),
      '*2\r\n$3\r\nGET\r\n$24\r\nclowder:desktop:instance\r\n',
    );
  });

  it('counts bytes rather than characters for multibyte values', () => {
    // '猫' is 3 UTF-8 bytes even though it is one code point.
    assert.equal(encodeCommand(['SET', 'k', '猫']), '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\n猫\r\n');
  });
});

describe('redis-ownership: RESP parsing', () => {
  it('parses a status reply', () => {
    assert.deepEqual(parseReply('+PONG\r\n'), { complete: true, kind: 'status', value: 'PONG' });
  });

  it('parses an error reply', () => {
    assert.deepEqual(parseReply('-ERR unknown command\r\n'), {
      complete: true,
      kind: 'error',
      error: 'ERR unknown command',
    });
  });

  it('parses an integer reply', () => {
    assert.deepEqual(parseReply(':5\r\n'), { complete: true, kind: 'integer', value: 5 });
  });

  it('parses a bulk string reply', () => {
    assert.deepEqual(parseReply('$3\r\nfoo\r\n'), { complete: true, kind: 'bulk', value: 'foo' });
  });

  it('parses a null bulk string as a missing key', () => {
    assert.deepEqual(parseReply('$-1\r\n'), { complete: true, kind: 'bulk', value: null });
  });

  it('reports incomplete replies instead of guessing', () => {
    assert.deepEqual(parseReply('$3\r\nfo'), { complete: false });
    assert.deepEqual(parseReply('$3'), { complete: false });
    assert.deepEqual(parseReply(''), { complete: false });
    assert.deepEqual(parseReply(undefined), { complete: false });
  });
});

describe('redis-ownership: adoption decision', () => {
  it('adopts a Redis whose marker matches this instance', () => {
    const result = evaluateRedisOwnership({ instanceId: 'inst-a', markerValue: 'inst-a' });

    assert.equal(result.canAdopt, true);
    assert.equal(result.verdict, OWNERSHIP.OWNED);
    assert.match(result.reason, /matches this instance/);
  });

  it('REFUSES a Redis owned by a different instance', () => {
    const result = evaluateRedisOwnership({ instanceId: 'inst-a', markerValue: 'inst-b' });

    assert.equal(result.canAdopt, false);
    assert.equal(result.verdict, OWNERSHIP.FOREIGN);
    assert.match(result.reason, /belongs to another instance \(inst-b\)/);
  });

  it('REFUSES an unmarked Redis (the production-server case)', () => {
    const nullBulk = parseReply('$-1\r\n');
    const result = evaluateRedisOwnership({ instanceId: 'inst-a', markerValue: nullBulk.value });

    assert.equal(result.canAdopt, false);
    assert.equal(result.verdict, OWNERSHIP.UNMARKED);
    assert.match(result.reason, new RegExp(INSTANCE_MARKER_KEY));
  });

  it('REFUSES an empty-string marker rather than treating it as a match', () => {
    const result = evaluateRedisOwnership({ instanceId: 'inst-a', markerValue: '' });

    assert.equal(result.canAdopt, false);
    assert.equal(result.verdict, OWNERSHIP.UNMARKED);
  });

  it('reports an unreachable port separately from a foreign one', () => {
    const result = evaluateRedisOwnership({ instanceId: 'inst-a', redisReachable: false });

    assert.equal(result.canAdopt, false);
    assert.equal(result.verdict, OWNERSHIP.UNREACHABLE);
  });
});

describe('redis-ownership: refusal message', () => {
  it('states what was refused, why, and what happens next', () => {
    const message = formatOwnershipRefusal({
      port: 6399,
      instanceId: 'inst-a',
      verdict: OWNERSHIP.UNMARKED,
      reason: 'no marker',
    });

    assert.match(message, /Refusing to use the Redis already listening on 127\.0\.0\.1:6399/);
    assert.match(message, /why:/);
    assert.match(message, /another application's data/);
    assert.match(message, /fix:/);
    assert.match(message, /instance id inst-a/);
  });

  it('explains the shared-database case for a foreign owner', () => {
    const message = formatOwnershipRefusal({
      port: 6399,
      instanceId: 'inst-a',
      verdict: OWNERSHIP.FOREIGN,
      reason: 'owned by inst-b',
    });

    assert.match(message, /another Clowder instance owns that Redis/);
  });
});
