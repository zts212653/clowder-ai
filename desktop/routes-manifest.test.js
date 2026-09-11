/**
 * Unit tests for desktop/routes-manifest.js.
 *
 * The fixture is the REAL `.next/routes-manifest.json` shape produced by Next
 * 14.2.35 for the probe app used to measure the behaviour (rewrites resolved at
 * build time, honoured from the manifest at `next start`, and not written back).
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  describeRewrites,
  hasApiRewrites,
  isAbsoluteHttpUrl,
  listRewrites,
  retargetDestination,
  retargetManifest,
  serializeManifest,
} = require('./routes-manifest');

/** Shape Next 14 writes: `rewrites` is a plain array. */
const NEXT14_MANIFEST = {
  version: 3,
  pages404: true,
  rewrites: [
    {
      source: '/api/:path*',
      destination: 'http://127.0.0.1:3004/api/:path*',
      regex: '^/api(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$',
    },
    { source: '/socket.io/:path*', destination: 'http://127.0.0.1:3004/socket.io/:path*' },
    { source: '/uploads/:path*', destination: 'http://127.0.0.1:3004/uploads/:path*' },
  ],
};

/** Shape older manifests used. */
const BUCKETED_MANIFEST = {
  rewrites: {
    beforeFiles: [{ source: '/api/:path*', destination: 'http://localhost:3004/api/:path*' }],
    afterFiles: [],
    fallback: [{ source: '/legacy', destination: 'https://example.com/legacy' }],
  },
};

describe('routes-manifest: destination retargeting', () => {
  it('replaces the origin and keeps the path, placeholder included', () => {
    assert.equal(
      retargetDestination('http://127.0.0.1:3004/api/:path*', 'http://127.0.0.1:4105'),
      'http://127.0.0.1:4105/api/:path*',
    );
    assert.equal(
      retargetDestination('http://localhost:3004/socket.io/:path*', 'http://127.0.0.1:4105'),
      'http://127.0.0.1:4105/socket.io/:path*',
    );
  });

  it('leaves relative destinations alone', () => {
    assert.equal(retargetDestination('/api/:path*', 'http://127.0.0.1:4105'), '/api/:path*');
    assert.equal(retargetDestination('uploads/x.png', 'http://127.0.0.1:4105'), 'uploads/x.png');
  });

  it('leaves non-strings alone', () => {
    assert.equal(retargetDestination(undefined, 'http://127.0.0.1:4105'), undefined);
    assert.equal(retargetDestination(null, 'http://127.0.0.1:4105'), null);
    assert.equal(retargetDestination(42, 'http://127.0.0.1:4105'), 42);
  });

  it('recognizes absolute http(s) only', () => {
    assert.equal(isAbsoluteHttpUrl('http://x/y'), true);
    assert.equal(isAbsoluteHttpUrl('HTTPS://x/y'), true);
    assert.equal(isAbsoluteHttpUrl('/y'), false);
    assert.equal(isAbsoluteHttpUrl('ws://x/y'), false);
  });
});

describe('routes-manifest: Next 14 array shape', () => {
  it('retargets every rewrite', () => {
    const patched = retargetManifest(NEXT14_MANIFEST, { apiOrigin: 'http://127.0.0.1:4105' });

    assert.deepEqual(
      patched.rewrites.map((rewrite) => rewrite.destination),
      [
        'http://127.0.0.1:4105/api/:path*',
        'http://127.0.0.1:4105/socket.io/:path*',
        'http://127.0.0.1:4105/uploads/:path*',
      ],
    );
  });

  it('preserves unrelated manifest keys and the regex', () => {
    const patched = retargetManifest(NEXT14_MANIFEST, { apiOrigin: 'http://127.0.0.1:4105' });

    assert.equal(patched.version, 3);
    assert.equal(patched.pages404, true);
    assert.equal(patched.rewrites[0].regex, NEXT14_MANIFEST.rewrites[0].regex);
    assert.equal(patched.rewrites[0].source, '/api/:path*');
  });

  it('does not mutate the input manifest', () => {
    const before = JSON.stringify(NEXT14_MANIFEST);
    retargetManifest(NEXT14_MANIFEST, { apiOrigin: 'http://127.0.0.1:4105' });

    assert.equal(JSON.stringify(NEXT14_MANIFEST), before);
  });
});

describe('routes-manifest: legacy bucketed shape', () => {
  it('retargets each bucket', () => {
    const patched = retargetManifest(BUCKETED_MANIFEST, { apiOrigin: 'http://127.0.0.1:4105' });

    assert.equal(patched.rewrites.beforeFiles[0].destination, 'http://127.0.0.1:4105/api/:path*');
    assert.equal(patched.rewrites.fallback[0].destination, 'http://127.0.0.1:4105/legacy');
    assert.deepEqual(patched.rewrites.afterFiles, []);
  });

  it('does not mutate the input', () => {
    const before = JSON.stringify(BUCKETED_MANIFEST);
    retargetManifest(BUCKETED_MANIFEST, { apiOrigin: 'http://127.0.0.1:4105' });

    assert.equal(JSON.stringify(BUCKETED_MANIFEST), before);
  });
});

describe('routes-manifest: degenerate manifests', () => {
  it('returns non-objects untouched', () => {
    assert.equal(retargetManifest(null, { apiOrigin: 'http://x' }), null);
    assert.equal(retargetManifest(undefined, { apiOrigin: 'http://x' }), undefined);
  });

  it('tolerates a manifest with no rewrites at all', () => {
    const manifest = { version: 3 };
    assert.deepEqual(retargetManifest(manifest, { apiOrigin: 'http://x' }), manifest);
    assert.deepEqual(listRewrites(manifest), []);
    assert.equal(hasApiRewrites(manifest), false);
  });
});

describe('routes-manifest: reporting', () => {
  it('flattens rewrites from both shapes', () => {
    assert.equal(listRewrites(NEXT14_MANIFEST).length, 3);
    assert.equal(listRewrites(BUCKETED_MANIFEST).length, 2);
    assert.deepEqual(listRewrites({}), []);
  });

  it('detects whether anything routes to an absolute API origin', () => {
    assert.equal(hasApiRewrites(NEXT14_MANIFEST), true);
    assert.equal(hasApiRewrites({ rewrites: [{ source: '/a', destination: '/b' }] }), false);
  });

  it('renders source -> destination lines', () => {
    const lines = describeRewrites(NEXT14_MANIFEST);

    assert.equal(lines.length, 3);
    assert.equal(lines[0], '/api/:path* -> http://127.0.0.1:3004/api/:path*');
  });

  it('serializes to compact JSON that round-trips', () => {
    const patched = retargetManifest(NEXT14_MANIFEST, { apiOrigin: 'http://127.0.0.1:4105' });
    const serialized = serializeManifest(patched);

    assert.ok(!serialized.includes('\n'), 'Next writes compact JSON');
    assert.deepEqual(JSON.parse(serialized), patched);
  });
});
