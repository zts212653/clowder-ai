// Redis ownership verification for the desktop app.
//
// Why this exists: the desktop app used to treat a responding Redis on its port
// as its own ("PING returned +PONG, so use it"). PING only proves the target is
// *a* Redis — not that it belongs to this desktop instance. On a machine that
// also runs a Clowder server (or any other app) on the same port, the desktop
// would silently attach to that database and start reading and writing it,
// which violates the project's data-storage sanctuary rule.
//
// Ownership is therefore proven with a marker key that only this app writes:
//   key   clowder:desktop:instance
//   value the instance id persisted in the user data directory
//
// Pure logic only (no sockets, no fs) so it is unit-tested everywhere; the
// socket IO lives in service-manager.js.

const INSTANCE_MARKER_KEY = 'clowder:desktop:instance';

/** Why an existing Redis on our port may or may not be reused. */
const OWNERSHIP = {
  OWNED: 'owned',
  FOREIGN: 'foreign',
  UNMARKED: 'unmarked',
  UNREACHABLE: 'unreachable',
};

/** Encode a command as a RESP array (what redis-cli sends over the wire). */
function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const value = String(arg);
    parts.push(`$${Buffer.byteLength(value)}\r\n${value}\r\n`);
  }
  return parts.join('');
}

/**
 * Parse one RESP reply from a partial buffer.
 * Returns { complete: false } when more bytes are needed.
 */
function parseReply(buffer) {
  if (typeof buffer !== 'string' || buffer.length === 0) return { complete: false };

  const lineEnd = buffer.indexOf('\r\n');
  if (lineEnd === -1) return { complete: false };

  const type = buffer[0];
  const line = buffer.slice(1, lineEnd);

  switch (type) {
    case '+':
      return { complete: true, kind: 'status', value: line };
    case '-':
      return { complete: true, kind: 'error', error: line };
    case ':':
      return { complete: true, kind: 'integer', value: Number(line) };
    case '$': {
      const length = Number(line);
      // Null bulk string: the key does not exist.
      if (length === -1) return { complete: true, kind: 'bulk', value: null };
      const start = lineEnd + 2;
      if (buffer.length < start + length + 2) return { complete: false };
      return { complete: true, kind: 'bulk', value: buffer.slice(start, start + length) };
    }
    default:
      return { complete: false };
  }
}

/**
 * Decide whether an already-listening Redis may be adopted by this instance.
 *
 * @param {{ instanceId: string, markerValue?: string|null, redisReachable?: boolean }} input
 * @returns {{ canAdopt: boolean, verdict: string, reason: string }}
 */
function evaluateRedisOwnership({ instanceId, markerValue, redisReachable = true }) {
  if (!redisReachable) {
    return {
      canAdopt: false,
      verdict: OWNERSHIP.UNREACHABLE,
      reason: 'the port is open but the process did not answer a Redis command',
    };
  }

  if (typeof markerValue === 'string' && markerValue.length > 0) {
    if (markerValue === instanceId) {
      return {
        canAdopt: true,
        verdict: OWNERSHIP.OWNED,
        reason: `marker "${INSTANCE_MARKER_KEY}" matches this instance`,
      };
    }
    return {
      canAdopt: false,
      verdict: OWNERSHIP.FOREIGN,
      reason: `marker "${INSTANCE_MARKER_KEY}" belongs to another instance (${markerValue})`,
    };
  }

  return {
    canAdopt: false,
    verdict: OWNERSHIP.UNMARKED,
    reason: `the Redis has no "${INSTANCE_MARKER_KEY}" marker, so it is not provably ours`,
  };
}

/**
 * Actionable explanation for refusing to attach to an existing Redis.
 * Follows the project error standard: what failed, why, how to fix.
 */
function formatOwnershipRefusal({ port, instanceId, verdict, reason }) {
  const lines = [
    `Refusing to use the Redis already listening on 127.0.0.1:${port}.`,
    `  why: ${reason}. Connecting would risk reading or overwriting another application's data.`,
  ];
  if (verdict === OWNERSHIP.FOREIGN) {
    lines.push(
      '  note: another Clowder instance owns that Redis. Two instances must not share one',
      '        database; start this one with its own data directory.',
    );
  } else if (verdict === OWNERSHIP.UNMARKED) {
    lines.push(
      '  note: this is expected when the port is used by a Clowder server, a system Redis,',
      '        or another product. The desktop app never adopts an unmarked database.',
    );
  }
  lines.push(
    `  fix: nothing to do — the desktop app will start its own Redis on a free port with`,
    `       instance id ${instanceId}. To attach to an existing database on purpose, stop`,
    '       this app and configure it explicitly instead of relying on port reuse.',
  );
  return lines.join('\n');
}

module.exports = {
  INSTANCE_MARKER_KEY,
  OWNERSHIP,
  encodeCommand,
  evaluateRedisOwnership,
  formatOwnershipRefusal,
  parseReply,
};
