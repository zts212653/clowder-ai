import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertPublicTestIsolation,
  denySanctuaryEndpoints,
  detectKernelNetworkBoundary,
  PUBLIC_TEST_DENY_REDIS_URL,
  SANCTUARY_REDIS_PORTS,
  validateIsolationAttestation,
} from '../scripts/public-test-isolation-preflight.mjs';

// Real /proc/net/route carries 11 columns per row (MTU/Window/IRTT included).
const IPV4_HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';
// A fresh `unshare --net` namespace after `ip link set lo up`: header only.
const emptyIpv4Route = () => `${IPV4_HEADER}\n`;
const loopbackIpv4Route = () => `${IPV4_HEADER}\nlo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0\n`;
const routableIpv4Route = () => `${IPV4_HEADER}\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n`;

// /proc/net/ipv6_route has no header and ends with the device name.
const emptyIpv6Route = () => '';
const loopbackIpv6Route = () =>
  '00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000001 00000001 80200001 lo\n';
const routableIpv6Route = () =>
  '00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000000 00000000 00000003 eth0\n';

const SEALED_STATUS = [
  'Name:\tnode',
  'Uid:\t1001\t1001\t1001\t1001',
  'NoNewPrivs:\t1',
  'CapInh:\t0000000000000000',
  'CapPrm:\t0000000000000000',
  'CapEff:\t0000000000000000',
  'CapBnd:\t0000000000000000',
  'CapAmb:\t0000000000000000',
].join('\n');

// A sealed launcher: netns distinct from PID 1, unprivileged, no_new_privs,
// every capability set empty — the same facts run-public-test-distributable.sh
// asserts before exec.
const sealedProbes = {
  readNamespaceProof: () => 'verified',
  readSelfStatus: () => SEALED_STATUS,
};

const verifiedProbes = {
  readRouteTable: emptyIpv4Route,
  readIpv6RouteTable: emptyIpv6Route,
  ...sealedProbes,
};
const sanctuaryPort = [...SANCTUARY_REDIS_PORTS][0];

describe('F308 public-test isolation preflight', () => {
  describe('kernel boundary detection covers both IP families', () => {
    it('reports verified for a fresh loopback-only namespace', () => {
      assert.equal(detectKernelNetworkBoundary({ platform: 'linux', ...verifiedProbes }), 'verified');
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          readRouteTable: loopbackIpv4Route,
          readIpv6RouteTable: loopbackIpv6Route,
          ...sealedProbes,
        }),
        'verified',
      );
    });

    it('reports absent for a routable device whose name starts with the header word', () => {
      // `Iface0` is a legal device name. Skipping rows by prefix instead of by
      // position dropped this route entirely and read the table as isolated.
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          readRouteTable: () => `${IPV4_HEADER}\nIface0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n`,
          readIpv6RouteTable: emptyIpv6Route,
          ...sealedProbes,
        }),
        'absent',
      );
    });

    it('reports absent when IPv4 has a routable interface', () => {
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          readRouteTable: routableIpv4Route,
          readIpv6RouteTable: emptyIpv6Route,
          ...sealedProbes,
        }),
        'absent',
      );
    });

    it('reports absent for an IPv6-only network whose IPv4 table is empty', () => {
      // Regression: an IPv6-only Docker network leaves /proc/net/route empty while
      // /proc/net/ipv6_route still carries a default route via eth0, and egress works.
      // An IPv4-only probe called this 'verified' — a real fail-open.
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          readRouteTable: emptyIpv4Route,
          readIpv6RouteTable: routableIpv6Route,
          ...sealedProbes,
        }),
        'absent',
      );
    });

    it('reports absent on platforms without network-namespace semantics', () => {
      assert.equal(detectKernelNetworkBoundary({ platform: 'darwin', ...verifiedProbes }), 'absent');
    });

    it('reports unknown when either family cannot be read', () => {
      const boom = () => {
        throw new Error('EACCES');
      };
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          readRouteTable: boom,
          readIpv6RouteTable: emptyIpv6Route,
          ...sealedProbes,
        }),
        'unknown',
      );
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          readRouteTable: emptyIpv4Route,
          readIpv6RouteTable: boom,
          ...sealedProbes,
        }),
        'unknown',
      );
    });

    it('reports unknown for malformed non-empty tables instead of reading them as empty', () => {
      // A best-effort split treats a truncated read or a future kernel format
      // change as "no routes found", i.e. as proof of isolation. Format drift
      // must fail closed.
      for (const ipv6 of ['lo\n', '0000 lo\n', 'not-hex 80 x x x x x x x lo\n']) {
        assert.equal(
          detectKernelNetworkBoundary({
            platform: 'linux',
            readRouteTable: emptyIpv4Route,
            readIpv6RouteTable: () => ipv6,
            ...sealedProbes,
          }),
          'unknown',
          `expected malformed ipv6 row ${JSON.stringify(ipv6)} to be unknown`,
        );
      }

      for (const ipv4 of [
        'lo\t0000007F\n',
        'lo\tZZZZZZZZ\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0\n',
        // A header alone is not an empty routing table. Both of these were
        // previously read as 'verified'.
        'Iface\n',
        'Iface garbage\n',
      ]) {
        assert.equal(
          detectKernelNetworkBoundary({
            platform: 'linux',
            readRouteTable: () => ipv4,
            readIpv6RouteTable: emptyIpv6Route,
            ...sealedProbes,
          }),
          'unknown',
          `expected malformed ipv4 table ${JSON.stringify(ipv4)} to be unknown`,
        );
      }
    });

    it('reports unknown for an entirely empty IPv4 read, which has no header at all', () => {
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          readRouteTable: () => '',
          readIpv6RouteTable: emptyIpv6Route,
          ...sealedProbes,
        }),
        'unknown',
      );
    });
  });

  describe('route-only evidence is never enough for verified', () => {
    const routeOnly = { readRouteTable: emptyIpv4Route, readIpv6RouteTable: emptyIpv6Route };

    it('refuses verified when the netns is the same as PID 1', () => {
      // An offline same-host Linux process reads exactly the empty route tables
      // a sealed namespace does. Sharing PID 1's netns settles it: this is the
      // host network, however empty its table happens to look.
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          ...routeOnly,
          ...sealedProbes,
          readNamespaceProof: () => 'absent',
        }),
        'absent',
      );
    });

    it('refuses verified when any of the four UIDs is root, not just the real one', () => {
      // `Uid:` is real/effective/saved/fs. Reading only the first value checks
      // the real UID, which says nothing about current privilege: this process
      // is running as root, and a zero saved UID could return to root anyway.
      const mixed = [
        ['effective', 'Uid:\t1001\t0\t1001\t1001'],
        ['saved', 'Uid:\t1001\t1001\t0\t1001'],
        ['filesystem', 'Uid:\t1001\t1001\t1001\t0'],
      ];
      for (const [label, uidLine] of mixed) {
        assert.equal(
          detectKernelNetworkBoundary({
            platform: 'linux',
            ...routeOnly,
            ...sealedProbes,
            readSelfStatus: () => SEALED_STATUS.replace('Uid:\t1001\t1001\t1001\t1001', uidLine),
          }),
          'absent',
          `expected a root ${label} UID to block verified`,
        );
      }
    });

    it('reports unknown when the Uid line does not carry all four values', () => {
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          ...routeOnly,
          ...sealedProbes,
          readSelfStatus: () => SEALED_STATUS.replace('Uid:\t1001\t1001\t1001\t1001', 'Uid:\t1001\t1001'),
        }),
        'unknown',
      );
    });

    it('refuses verified when running as root, even in a distinct netns', () => {
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          ...routeOnly,
          ...sealedProbes,
          readSelfStatus: () => SEALED_STATUS.replace('Uid:\t1001\t1001\t1001\t1001', 'Uid:\t0\t0\t0\t0'),
        }),
        'absent',
      );
    });

    it('refuses verified when no_new_privs is not set', () => {
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          ...routeOnly,
          ...sealedProbes,
          readSelfStatus: () => SEALED_STATUS.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'),
        }),
        'absent',
      );
    });

    it('refuses verified when any capability set is non-empty', () => {
      for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
        assert.equal(
          detectKernelNetworkBoundary({
            platform: 'linux',
            ...routeOnly,
            ...sealedProbes,
            readSelfStatus: () => SEALED_STATUS.replace(`${field}:\t0000000000000000`, `${field}:\t000001ffffffffff`),
          }),
          'absent',
          `expected a non-empty ${field} to block verified`,
        );
      }
    });

    it('reports unknown when the namespace or status probes cannot be read', () => {
      const boom = () => {
        throw new Error('EACCES');
      };
      for (const override of [{ readNamespaceProof: boom }, { readSelfStatus: boom }]) {
        assert.equal(
          detectKernelNetworkBoundary({ platform: 'linux', ...routeOnly, ...sealedProbes, ...override }),
          'unknown',
        );
      }
    });

    it('reports unknown when a required status field is missing entirely', () => {
      assert.equal(
        detectKernelNetworkBoundary({
          platform: 'linux',
          ...routeOnly,
          ...sealedProbes,
          readSelfStatus: () => 'Name:\tnode\nUid:\t1001\t1001\t1001\t1001\n',
        }),
        'unknown',
      );
    });

    it('does not let an unsealed route-only reading become target-grade evidence', () => {
      assert.throws(
        () =>
          assertPublicTestIsolation({
            resourceScope: 'distributable',
            platform: 'linux',
            ...routeOnly,
            ...sealedProbes,
            readNamespaceProof: () => 'absent',
          }),
        /kernel\s+network boundary/i,
      );
    });
  });

  describe('a verified route table is not by itself proof of isolation', () => {
    // Counter-example: `docker run --network none` produces exactly the route
    // tables this probe calls 'verified', yet a service bound to 127.0.0.1
    // inside that namespace stays reachable. An offline Linux developer machine
    // is indistinguishable from it. So the shard child's endpoints are denied
    // deterministically, independently of what the probe concluded.
    it('rewrites an inherited sanctuary endpoint to the deny endpoint', () => {
      const { env, redirected } = denySanctuaryEndpoints({ REDIS_URL: `redis://localhost:${sanctuaryPort}` });
      assert.equal(env.REDIS_URL, PUBLIC_TEST_DENY_REDIS_URL);
      assert.equal(redirected.reason, 'sanctuary_endpoint');
    });

    it('treats an unset REDIS_URL as the sanctuary, because the shared default is', () => {
      const { env, redirected } = denySanctuaryEndpoints({});
      assert.equal(env.REDIS_URL, PUBLIC_TEST_DENY_REDIS_URL);
      assert.equal(redirected.reason, 'sanctuary_endpoint');
    });

    it('denies any other inherited endpoint too, rather than trusting it', () => {
      const { env, redirected } = denySanctuaryEndpoints({ REDIS_URL: 'redis://localhost:6398' });
      assert.equal(env.REDIS_URL, PUBLIC_TEST_DENY_REDIS_URL);
      assert.equal(redirected.reason, 'non_deny_endpoint');
    });

    it('never reproduces credentials from the endpoint it replaced', () => {
      const { redirected } = denySanctuaryEndpoints({
        REDIS_URL: `redis://admin:hunter2@cache.internal:${sanctuaryPort}`,
      });
      assert.equal(JSON.stringify(redirected).includes('hunter2'), false);
      assert.equal(redirected.from, `redis://cache.internal:${sanctuaryPort}`);
    });

    it('picks a deny endpoint that cannot satisfy any suite availability predicate', () => {
      // auth-invocation-restart gates on ':6398'; backend-contract gates on the
      // 6300..6999 window. The deny endpoint must match neither, or it would
      // wake suites that have never run instead of keeping them skipped.
      const port = Number(new URL(PUBLIC_TEST_DENY_REDIS_URL).port);
      assert.equal(PUBLIC_TEST_DENY_REDIS_URL.includes(':6398'), false);
      assert.equal(port >= 6300 && port <= 6999, false);
      assert.equal(SANCTUARY_REDIS_PORTS.has(String(port)), false);
    });

    it('leaves every other inherited variable untouched', () => {
      const { env } = denySanctuaryEndpoints({
        REDIS_URL: `redis://localhost:${sanctuaryPort}`,
        PATH: '/usr/bin',
        FOO: 'bar',
      });
      assert.equal(env.PATH, '/usr/bin');
      assert.equal(env.FOO, 'bar');
    });
  });

  describe('attestation cannot be hand-written into a pass', () => {
    const valid = {
      schemaVersion: 1,
      kind: 'public_test_isolation_attestation',
      resourceScope: 'distributable',
      boundary: 'verified',
      targetGrade: true,
    };

    it('accepts a self-consistent attestation that matches its lane', () => {
      assert.deepEqual(validateIsolationAttestation(valid, 'distributable'), []);
    });

    it('rejects an unrecognized schemaVersion no producer emits', () => {
      const problems = validateIsolationAttestation({ ...valid, schemaVersion: 999 }, 'distributable');
      assert.ok(problems.some((problem) => /schemaVersion/.test(problem)));
    });

    it('rejects a distributable lane whose attestation claims shared scope', () => {
      const problems = validateIsolationAttestation(
        { ...valid, resourceScope: 'shared', targetGrade: false },
        'distributable',
      );
      assert.ok(problems.some((problem) => /resourceScope/.test(problem)));
    });

    it('rejects a shared lane whose attestation claims distributable scope', () => {
      const problems = validateIsolationAttestation(valid, 'shared');
      assert.ok(problems.some((problem) => /resourceScope/.test(problem)));
    });

    it('rejects a hand-set targetGrade that contradicts scope and boundary', () => {
      const problems = validateIsolationAttestation(
        { ...valid, boundary: 'absent', targetGrade: true },
        'distributable',
      );
      assert.ok(problems.some((problem) => /targetGrade/.test(problem)));
    });

    it('rejects an unrecognized boundary state', () => {
      const problems = validateIsolationAttestation({ ...valid, boundary: 'probably-fine' }, 'distributable');
      assert.ok(problems.some((problem) => /boundary/.test(problem)));
    });

    it('rejects a missing attestation', () => {
      assert.deepEqual(validateIsolationAttestation(undefined, 'shared'), ['isolation attestation is missing']);
    });
  });

  describe('distributable lanes require a proved boundary, with no opt-out', () => {
    it('fails closed without a verified boundary', () => {
      assert.throws(
        () => assertPublicTestIsolation({ resourceScope: 'distributable', platform: 'darwin' }),
        /kernel\s+network boundary/i,
      );
    });

    it('fails closed when detection is unknown rather than assuming isolation', () => {
      assert.throws(
        () =>
          assertPublicTestIsolation({
            resourceScope: 'distributable',
            platform: 'linux',
            readRouteTable: () => {
              throw new Error('EACCES');
            },
            readIpv6RouteTable: emptyIpv6Route,
            ...sealedProbes,
          }),
        /kernel\s+network boundary/i,
      );
    });

    it('states plainly that there is no opt-out', () => {
      assert.throws(
        () => assertPublicTestIsolation({ resourceScope: 'distributable', platform: 'darwin' }),
        /no opt-out/i,
      );
    });

    it('admits a distributable lane inside a proved namespace and marks it target-grade', () => {
      const result = assertPublicTestIsolation({
        resourceScope: 'distributable',
        platform: 'linux',
        ...verifiedProbes,
      });
      assert.equal(result.boundary, 'verified');
      assert.equal(result.attestation.targetGrade, true);
      assert.equal(result.attestation.kind, 'public_test_isolation_attestation');
      // The produced attestation must satisfy the validator consumers apply.
      assert.deepEqual(validateIsolationAttestation(result.attestation, 'distributable'), []);
    });

    it('does not require a kernel boundary for the shared-resource lane, and never marks it target-grade', () => {
      const result = assertPublicTestIsolation({ resourceScope: 'shared', platform: 'darwin' });
      assert.equal(result.boundary, 'absent');
      assert.equal(result.attestation.targetGrade, false);
      assert.deepEqual(validateIsolationAttestation(result.attestation, 'shared'), []);
    });
  });
});
