import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateBundleArch,
  formatBundleArchFailure,
  machOArchForBuildArch,
  parseLipoArchs,
  parseNativePath,
} from './mac-native-arch.mjs';

const API = 'Contents/Resources/packages/api/node_modules';

/**
 * REAL `lipo -archs` measurements from `build-mac.sh` (default ARCHS=arm64+x64)
 * running on a single arm64 macOS runner (macos-26-arm64, run 34461497456).
 *
 * Both arch bundles were produced from ONE host dependency install, so the
 * arch-specific modules are byte-identical in the arm64 and x64 .app — that is
 * precisely the bug: the x64 bundle inherits the arm64 modules.
 */
const BUNDLE = [
  // Arch-specific single builds — the ones that actually break.
  { path: `${API}/better-sqlite3/build/Release/better_sqlite3.node`, archs: ['arm64'] },
  { path: `${API}/sqlite-vec-darwin-arm64/vec0.dylib`, archs: ['arm64'] },
  // Multi-variant family: node-pty ships every platform/arch, resolved at runtime.
  { path: `${API}/node-pty/prebuilds/darwin-arm64/pty.node`, archs: ['arm64'] },
  { path: `${API}/node-pty/prebuilds/darwin-x64/pty.node`, archs: ['x86_64'] },
  { path: `${API}/node-pty/prebuilds/linux-arm64/pty.node`, archs: [] },
  { path: `${API}/node-pty/prebuilds/linux-x64/pty.node`, archs: [] },
];

describe('machOArchForBuildArch', () => {
  it('maps build arch labels to Mach-O arch names', () => {
    assert.equal(machOArchForBuildArch('arm64'), 'arm64');
    assert.equal(machOArchForBuildArch('x64'), 'x86_64');
  });

  it('fails loudly on an unknown arch', () => {
    assert.throws(() => machOArchForBuildArch('ppc64'), /Unsupported macOS build arch "ppc64"/);
  });
});

describe('parseLipoArchs', () => {
  it('parses single and universal outputs', () => {
    assert.deepEqual(parseLipoArchs('arm64'), ['arm64']);
    assert.deepEqual(parseLipoArchs('x86_64 arm64\n'), ['arm64', 'x86_64']);
    assert.deepEqual(parseLipoArchs('  arm64   arm64 '), ['arm64']);
  });

  it('returns an empty list for missing or unreadable output', () => {
    assert.deepEqual(parseLipoArchs(''), []);
    assert.deepEqual(parseLipoArchs(undefined), []);
  });
});

describe('parseNativePath', () => {
  it('detects platform-arch tokens in parent directories', () => {
    assert.deepEqual(parseNativePath(`${API}/sqlite-vec-darwin-arm64/vec0.dylib`), {
      platform: 'darwin',
      archToken: 'arm64',
      familyKey: `${API}/sqlite-vec-darwin-<arch>/vec0.dylib`,
    });
  });

  it('leaves arch-pinned single builds unpinned', () => {
    const parsed = parseNativePath(`${API}/better-sqlite3/build/Release/better_sqlite3.node`);
    assert.equal(parsed.platform, null);
    assert.equal(parsed.archToken, null);
  });
});

describe('evaluateBundleArch', () => {
  it('accepts the measured arm64 bundle on an arm64 target', () => {
    const result = evaluateBundleArch({ targetArch: 'arm64', entries: BUNDLE });
    assert.equal(result.ok, true, JSON.stringify(result.mismatches, null, 2));
    assert.equal(result.targetMachO, 'arm64');
  });

  it('REGRESSION: rejects the x64 bundle that shipped arm64 native modules', () => {
    const result = evaluateBundleArch({ targetArch: 'x64', entries: BUNDLE });

    assert.equal(result.ok, false);
    const offenders = result.mismatches.map((m) => m.path).sort();
    assert.deepEqual(offenders, [
      `${API}/better-sqlite3/build/Release/better_sqlite3.node`,
      `${API}/sqlite-vec-darwin-arm64/vec0.dylib`,
    ]);
    assert.match(result.mismatches[0].reason, /target needs x86_64/);
  });

  it('does not flag multi-variant prebuild families that contain the target', () => {
    // node-pty carries BOTH darwin variants; the loader picks at runtime.
    const result = evaluateBundleArch({ targetArch: 'x64', entries: BUNDLE });
    const ptyOffenders = result.mismatches.filter((m) => m.path.includes('pty.node'));
    assert.deepEqual(ptyOffenders, []);
  });

  it('flags a darwin family that lacks the target variant', () => {
    const result = evaluateBundleArch({
      targetArch: 'x64',
      entries: [{ path: `${API}/node-pty/prebuilds/darwin-arm64/pty.node`, archs: ['arm64'] }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.mismatches.length, 1);
    assert.match(result.mismatches[0].reason, /path declares "arm64" but the target is "x64"/);
  });

  it('accepts a family once the matching variant is present', () => {
    const result = evaluateBundleArch({
      targetArch: 'x64',
      entries: [
        { path: `${API}/node-pty/prebuilds/darwin-arm64/pty.node`, archs: ['arm64'] },
        { path: `${API}/node-pty/prebuilds/darwin-x64/pty.node`, archs: ['x86_64'] },
      ],
    });
    assert.equal(result.ok, true);
  });

  it('ignores foreign-platform prebuilds instead of failing on them', () => {
    const result = evaluateBundleArch({ targetArch: 'arm64', entries: BUNDLE });
    const skipped = result.skipped.map((e) => e.path);
    assert.deepEqual(skipped, [
      `${API}/node-pty/prebuilds/linux-arm64/pty.node`,
      `${API}/node-pty/prebuilds/linux-x64/pty.node`,
    ]);
    assert.deepEqual(result.unreadable, []);
  });

  it('treats a universal binary as satisfying either target', () => {
    const entries = [{ path: `${API}/native/thing.node`, archs: ['arm64', 'x86_64'] }];
    assert.equal(evaluateBundleArch({ targetArch: 'arm64', entries }).ok, true);
    assert.equal(evaluateBundleArch({ targetArch: 'x64', entries }).ok, true);
  });

  it('accepts an explicitly universal-labelled variant', () => {
    const entries = [{ path: `${API}/pkg-darwin-universal/thing.dylib`, archs: ['arm64', 'x86_64'] }];
    assert.equal(evaluateBundleArch({ targetArch: 'x64', entries }).ok, true);
  });

  it('reports unreadable binaries separately from mismatches', () => {
    const result = evaluateBundleArch({
      targetArch: 'x64',
      entries: [{ path: `${API}/broken.node`, error: 'lipo failed' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.mismatches.length, 0);
    assert.equal(result.unreadable.length, 1);
  });
});

describe('formatBundleArchFailure', () => {
  it('states what failed, why, and how to fix it', () => {
    const result = evaluateBundleArch({
      targetArch: 'x64',
      entries: [{ path: `${API}/better-sqlite3/build/Release/better_sqlite3.node`, archs: ['arm64'] }],
    });
    const message = formatBundleArchFailure({
      appPath: '/tmp/mac/Clowder AI.app',
      targetArch: 'x64',
      result,
    });

    assert.match(message, /architecture check failed for x64/);
    assert.match(message, /why: 1 native binary/);
    assert.match(message, /better_sqlite3\.node/);
    assert.match(message, /fix:/);
    assert.match(message, /--config\.arch=x64/);
  });
});
