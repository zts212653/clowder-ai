// Port pair allocation for the desktop runtime.
//
// The renderer derives its API base from its own origin: packages/web's
// api-client resolves `location.port + 1` when the page is served from an
// explicit port (and same-origin when it is not). The Web and API ports are
// therefore NOT independent — if they drift apart, every client request goes to
// the wrong place while the page still loads, which looks like "the app is up
// but nothing works".
//
// This module owns that invariant, the candidate list and the remembered-pair
// normalization. Probing sockets is async and lives in service-manager.js.

const DEFAULT_FRONTEND_PORT = 3003;
const API_PORT_OFFSET = 1;
const MAX_PORT = 65535;
const DEFAULT_ATTEMPTS = 10;

/** The companion API port for a frontend port. */
function createPortPair(frontend) {
  return { frontend, api: frontend + API_PORT_OFFSET };
}

/** True when a pair is usable and keeps the adjacency invariant. */
function isValidPortPair(pair) {
  return (
    Boolean(pair) &&
    Number.isInteger(pair.frontend) &&
    Number.isInteger(pair.api) &&
    pair.frontend >= 1 &&
    pair.api <= MAX_PORT &&
    pair.api === pair.frontend + API_PORT_OFFSET
  );
}

/**
 * Candidate pairs to try, default first, stopping at the port ceiling.
 * @returns {Array<{frontend: number, api: number}>}
 */
function portPairCandidates({ base = DEFAULT_FRONTEND_PORT, attempts = DEFAULT_ATTEMPTS } = {}) {
  const pairs = [];
  for (let offset = 0; offset < attempts; offset += 1) {
    const pair = createPortPair(base + offset);
    if (pair.api > MAX_PORT) break;
    pairs.push(pair);
  }
  return pairs;
}

/**
 * Validate a pair remembered in the instance record.
 * A record written by an older build, or hand-edited into an invalid state,
 * yields null so the caller falls back to the default instead of trusting it.
 */
function normalizeRememberedPair(record) {
  if (!record) return null;
  const pair = { frontend: record.frontendPort, api: record.apiPort };
  return isValidPortPair(pair) ? pair : null;
}

/** Same pair, for cheap equality checks. */
function isSamePair(a, b) {
  return Boolean(a) && Boolean(b) && a.frontend === b.frontend && a.api === b.api;
}

module.exports = {
  API_PORT_OFFSET,
  DEFAULT_FRONTEND_PORT,
  MAX_PORT,
  createPortPair,
  isSamePair,
  isValidPortPair,
  normalizeRememberedPair,
  portPairCandidates,
};
