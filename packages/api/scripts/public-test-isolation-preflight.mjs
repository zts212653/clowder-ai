import { readFileSync } from 'node:fs';
import { observeNamespaceProof } from './public-test-namespace-proof.mjs';

/**
 * F308 public-test isolation preflight.
 *
 * `public-test-shard-classification.json` declares every distributable file's
 * isolation evidence as `kernel-no-egress-plus-runtime-guard`. That evidence
 * only exists in target CI, where the lane is launched inside a loopback-only
 * network namespace. Without this check the same classification is consumed
 * wherever `test:public:shard` runs, including a developer machine that has no
 * such boundary — the default-distributable model would then rest on half of
 * its stated basis.
 *
 * Route tables alone are necessary but not sufficient: they cannot distinguish
 * a namespaced loopback from the host's, so `verified` additionally reproduces
 * the launcher's root-owned kernel receipt — this netns is distinct from the
 * host's — plus unprivileged UIDs, no_new_privs and empty capability sets.
 *
 * There is deliberately no opt-out. Without the OS boundary a test reaches any
 * local endpoint through a direct socket, a shell, or an unrecognized child
 * process; loopback targets in particular are outside the preload guard's
 * non-loopback rules entirely. Enumerating more APIs in that guard cannot
 * substitute for a kernel guarantee — it only moves the boundary to wherever
 * the enumeration stops. Distributable lanes therefore run only where the
 * boundary is proved; locally, use the shared lane or the non-sharded path.
 */

const HEX_FIELD = /^[0-9A-Fa-f]+$/;

/** Redis ports public tests must never touch. Iron rule 1. */
export const SANCTUARY_REDIS_PORTS = new Set(['6399']);

/**
 * Endpoint every shard child's REDIS_URL is rewritten to.
 *
 * A route table with no non-loopback entry does NOT prove that this loopback is
 * isolated from the host: `--network none` reports exactly the same table while
 * a service on 127.0.0.1 inside it stays reachable, and a Linux developer
 * machine that is simply offline looks identical. So the boundary probe cannot
 * be the only thing standing between a shard child and the sanctuary.
 *
 * Port 0 is deliberate. It is not the isolated dev port 6398 and not inside the
 * 6300..6999 window, so this value cannot satisfy any suite's "a Redis is
 * available" predicate — those suites keep skipping instead of waking up
 * against an endpoint they were never run against. Port 0 is also not a
 * connectable destination at all (`EADDRNOTAVAIL`), unlike a low registered
 * port such as 1/tcpmux where "nothing listens there" is an assumption about
 * the host rather than a property of the address. `sharedResources` is empty,
 * so no public test is entitled to a shared endpoint in the first place.
 *
 * This is deliberately narrower than pinning REDIS_URL for every entrypoint:
 * that broader change belongs with the test fixes it activates.
 */
export const PUBLIC_TEST_DENY_REDIS_URL = 'redis://127.0.0.1:0';

/**
 * Environment for a shard child: the caller's environment with REDIS_URL
 * replaced by the deny endpoint, never inherited.
 *
 * Returns the rewritten environment plus a redacted record of what was
 * replaced, so the substitution is reported rather than silent.
 */
export function denySanctuaryEndpoints(env = {}) {
  const incoming = typeof env.REDIS_URL === 'string' && env.REDIS_URL.trim() !== '' ? env.REDIS_URL.trim() : null;
  let from = '<unset>';
  let wasSanctuary = false;
  if (incoming !== null) {
    try {
      const parsed = new URL(incoming);
      const port = parsed.port === '' ? '<no-port>' : parsed.port;
      // Redacted: a REDIS_URL can carry user:password and must not be echoed.
      from = `${parsed.protocol}//${parsed.hostname}:${port}`;
      wasSanctuary = SANCTUARY_REDIS_PORTS.has(parsed.port);
    } catch {
      from = '<unparseable>';
    }
  } else {
    // packages/shared/src/utils/redis.ts falls back to the sanctuary when
    // REDIS_URL is unset, so "unset" is the dangerous case, not the safe one.
    wasSanctuary = true;
  }
  return {
    env: { ...env, REDIS_URL: PUBLIC_TEST_DENY_REDIS_URL },
    redirected: {
      from,
      to: PUBLIC_TEST_DENY_REDIS_URL,
      reason: wasSanctuary ? 'sanctuary_endpoint' : 'non_deny_endpoint',
    },
  };
}

/**
 * Parse a kernel route table into "is any non-loopback route present".
 *
 * Returns `null` for anything that does not match the expected schema. A
 * best-effort split would treat a truncated read or a future format change as
 * "no routes found" and therefore as proof of isolation — the exact fail-open
 * this module exists to prevent. An empty route set is legitimately verified;
 * a non-empty malformed one is not parseable and must become 'unknown'.
 *
 * Shapes (see fib_seq_show / ipv6_route_native_seq_show in the kernel):
 *   IPv4: header line starting with "Iface", then 11 tab-separated columns
 *         beginning with the device name.
 *   IPv6: no header, 10 whitespace-separated columns ending with the device
 *         name; the leading columns are hex.
 */
function parseRouteTable(table, family) {
  const rows = table
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row !== '');

  if (family === 'ipv4') {
    if (rows.length === 0) return null;
    // The header itself must carry the full schema. "Iface\n" alone, or a
    // header with unexpected columns, means a truncated or drifted read — not
    // an empty routing table.
    const header = rows[0].split(/\s+/);
    const expected = [
      'Iface',
      'Destination',
      'Gateway',
      'Flags',
      'RefCnt',
      'Use',
      'Metric',
      'Mask',
      'MTU',
      'Window',
      'IRTT',
    ];
    if (header.length !== expected.length) return null;
    if (!header.every((column, index) => column === expected[index])) return null;
  }

  let sawNonLoopback = false;
  for (const [index, row] of rows.entries()) {
    // Skip the header by position, not by prefix: `Iface0` is a legal device
    // name, so a prefix test would silently drop a real non-loopback route and
    // read the table as isolated.
    if (family === 'ipv4' && index === 0) continue;
    const columns = row.split(/\s+/);

    if (family === 'ipv4') {
      // Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
      if (columns.length < 11) return null;
      const [iface, destination, gateway] = columns;
      if (!HEX_FIELD.test(destination) || !HEX_FIELD.test(gateway)) return null;
      if (iface !== 'lo') sawNonLoopback = true;
      continue;
    }

    // dst prefix src prefix nexthop metric refcnt use flags dev
    if (columns.length !== 10) return null;
    const device = columns[9];
    if (!HEX_FIELD.test(columns[0]) || !HEX_FIELD.test(columns[1])) return null;
    if (device !== 'lo') sawNonLoopback = true;
  }

  return { sawNonLoopback };
}

/**
 * Detect whether this process runs inside a network namespace with no route off
 * the host, across *both* IP families.
 *
 * Returns:
 *   'verified' — IPv4 and IPv6 route tables each expose no non-loopback route
 *   'absent'   — either family has a routable interface, or the platform has no
 *                network-namespace semantics
 *   'unknown'  — either family could not be read or parsed
 *
 * Checking only IPv4 would be a real fail-open: an IPv6-only network leaves
 * /proc/net/route empty while /proc/net/ipv6_route still carries a default
 * route through eth0, and egress works. 'unknown' stays a distinct third state
 * — a failed probe is never folded into 'verified'.
 */
export function detectKernelNetworkBoundary({
  platform = process.platform,
  readRouteTable = () => readFileSync('/proc/net/route', 'utf8'),
  readIpv6RouteTable = () => readFileSync('/proc/net/ipv6_route', 'utf8'),
  readNamespaceProof = observeNamespaceProof,
  readSelfStatus = () => readFileSync('/proc/self/status', 'utf8'),
} = {}) {
  if (platform !== 'linux') return 'absent';

  let ipv4Table;
  try {
    ipv4Table = readRouteTable();
  } catch {
    return 'unknown';
  }
  if (typeof ipv4Table !== 'string') return 'unknown';

  let ipv6Table;
  try {
    ipv6Table = readIpv6RouteTable();
  } catch {
    return 'unknown';
  }
  if (typeof ipv6Table !== 'string') return 'unknown';

  const ipv4 = parseRouteTable(ipv4Table, 'ipv4');
  const ipv6 = parseRouteTable(ipv6Table, 'ipv6');
  // A table we cannot parse is not evidence of isolation.
  if (ipv4 === null || ipv6 === null) return 'unknown';
  // A routable interface is conclusive the other way: egress exists.
  if (ipv4.sawNonLoopback || ipv6.sawNonLoopback) return 'absent';

  // Route tables are necessary but nowhere near sufficient. They cannot tell a
  // namespaced loopback apart from the host's own, so an offline same-host
  // Linux process produces an identical reading. `verified` must therefore
  // reproduce the invariants the target launcher actually establishes.
  return detectLauncherSeal({ readNamespaceProof, readSelfStatus });
}

const CAPABILITY_FIELDS = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'];

/**
 * Reproduce the seal the target launcher establishes before it runs tests:
 * a network namespace distinct from PID 1's, running unprivileged, with
 * `no_new_privs` set and every capability set empty.
 *
 * Anything unreadable is 'unknown'; anything readable but unmet is 'absent'.
 * Only the full set yields 'verified' — the same facts
 * `.github/scripts/run-public-test-distributable.sh` asserts before `exec`.
 */
function detectLauncherSeal({ readNamespaceProof, readSelfStatus }) {
  let namespaceBoundary;
  try {
    namespaceBoundary = readNamespaceProof();
  } catch {
    return 'unknown';
  }
  if (namespaceBoundary !== 'verified') return namespaceBoundary === 'absent' ? 'absent' : 'unknown';

  let status;
  try {
    status = readSelfStatus();
  } catch {
    return 'unknown';
  }
  if (typeof status !== 'string') return 'unknown';

  const field = (name) => status.split('\n').find((line) => line.startsWith(`${name}:`));

  // `Uid:` carries real, effective, saved and filesystem UIDs. Reading only the
  // first value checks the *real* UID, which says nothing about what the
  // process can do: `Uid: 1001 0 0 0` is running as root right now, and a
  // non-zero real UID with a zero saved UID can return to root at will. Every
  // one of the four must be unprivileged.
  const uidLine = field('Uid');
  if (uidLine === undefined) return 'unknown';
  const uids = uidLine.split(/\s+/).slice(1);
  if (uids.length < 4 || uids.some((uid) => !/^\d+$/.test(uid))) return 'unknown';
  if (uids.some((uid) => uid === '0')) return 'absent';

  const noNewPrivs = field('NoNewPrivs');
  if (noNewPrivs === undefined) return 'unknown';
  if (noNewPrivs.split(/\s+/)[1] !== '1') return 'absent';

  for (const name of CAPABILITY_FIELDS) {
    const line = field(name);
    if (line === undefined) return 'unknown';
    const value = line.split(/\s+/)[1];
    if (value === undefined || !/^0+$/.test(value)) return 'absent';
  }

  return 'verified';
}

function fail(detail) {
  throw new Error(`public_test_isolation_violation: ${detail}`);
}

/**
 * Assert that a shard lane may run in the current environment, and return the
 * attestation describing what was proved.
 *
 * The attestation is the point: a lane report that cannot show
 * `boundary: 'verified'` must not be usable as target-grade evidence
 * downstream.
 */
export function assertPublicTestIsolation({
  resourceScope,
  platform = process.platform,
  readRouteTable,
  readIpv6RouteTable,
  readNamespaceProof,
  readSelfStatus,
} = {}) {
  const boundary = detectKernelNetworkBoundary({
    platform,
    readRouteTable,
    readIpv6RouteTable,
    readNamespaceProof,
    readSelfStatus,
  });

  if (resourceScope === 'distributable' && boundary !== 'verified') {
    fail(
      'distributable lanes claim isolation evidence "kernel-no-egress-plus-runtime-guard", but the kernel ' +
        `network boundary is ${boundary} here. Target CI supplies it via a loopback-only namespace; a local run ` +
        'does not, and without it the preload guard cannot constrain direct sockets, shells or unrecognized ' +
        'children. There is no opt-out: run the shared-resource lane, or use the non-sharded public test path ' +
        'locally.',
    );
  }

  return {
    attestation: {
      schemaVersion: PUBLIC_TEST_ATTESTATION_SCHEMA_VERSION,
      kind: 'public_test_isolation_attestation',
      resourceScope,
      boundary,
      // Target-grade means: a distributable lane that proved its kernel
      // boundary. Anything else must not be mistaken for CI evidence.
      targetGrade: resourceScope === 'distributable' && boundary === 'verified',
    },
    boundary,
  };
}

export const PUBLIC_TEST_ATTESTATION_SCHEMA_VERSION = 1;

const BOUNDARY_STATES = new Set(['verified', 'absent', 'unknown']);
const RESOURCE_SCOPES = new Set(['shared', 'distributable']);

/**
 * Validate an isolation attestation carried by a lane report.
 *
 * Checking only `kind` and `boundary` is not enough: a hand-written record can
 * claim `boundary: 'verified'` while declaring a scope that contradicts the
 * lane it came from, or an unrecognized schemaVersion that no producer emits.
 * Every field is therefore re-derived and cross-checked against the lane's
 * actual scope, so the attestation cannot assert more than its own shape
 * supports.
 *
 * Returns an array of problems; empty means the attestation is internally
 * consistent and matches `expectedResourceScope`.
 */
export function validateIsolationAttestation(attestation, expectedResourceScope) {
  const problems = [];
  if (!attestation || typeof attestation !== 'object') {
    return ['isolation attestation is missing'];
  }
  if (attestation.kind !== 'public_test_isolation_attestation') {
    problems.push(`isolation attestation has unexpected kind ${String(attestation.kind)}`);
  }
  if (attestation.schemaVersion !== PUBLIC_TEST_ATTESTATION_SCHEMA_VERSION) {
    problems.push(
      `isolation attestation schemaVersion ${String(attestation.schemaVersion)} is not ` +
        `${PUBLIC_TEST_ATTESTATION_SCHEMA_VERSION}; no producer emits that shape`,
    );
  }
  if (!BOUNDARY_STATES.has(attestation.boundary)) {
    problems.push(`isolation attestation has unrecognized boundary ${String(attestation.boundary)}`);
  }
  if (!RESOURCE_SCOPES.has(attestation.resourceScope)) {
    problems.push(`isolation attestation has unrecognized resourceScope ${String(attestation.resourceScope)}`);
  } else if (attestation.resourceScope !== expectedResourceScope) {
    problems.push(
      `isolation attestation claims resourceScope ${attestation.resourceScope} but the lane is ` +
        `${expectedResourceScope}`,
    );
  }
  // targetGrade is derived, never asserted: recompute it and reject a mismatch.
  const derivedTargetGrade = attestation.resourceScope === 'distributable' && attestation.boundary === 'verified';
  if (attestation.targetGrade !== derivedTargetGrade) {
    problems.push(
      `isolation attestation targetGrade ${String(attestation.targetGrade)} contradicts ` +
        `resourceScope=${String(attestation.resourceScope)} boundary=${String(attestation.boundary)}`,
    );
  }
  return problems;
}
