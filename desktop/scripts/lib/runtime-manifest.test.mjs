/**
 * Tests for desktop/scripts/lib/runtime-manifest.mjs.
 *
 * Two jobs:
 *   1. the shipped manifest is valid, and the validator rejects incoherent ones
 *   2. the places that used to repeat the runtime facts still agree with the
 *      manifest — this is what turns "single source of truth" from a claim
 *      into something CI enforces
 *
 * (2) is the guard that would have caught the drift this work started from:
 * the README asking for Node >= 20 while the repo required >= 24, and Windows
 * resolving Redis through `releases/latest` while macOS pinned 7.4.1.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  detectRedisDivergence,
  REDIS_DIVERGENCE_ID,
  redisVersionFor,
  redisVersionsByPlatform,
  requiredNodeMajor,
  validateRuntimeManifest,
  windowsRedisAssetName,
  windowsRedisReleaseTag,
} from './runtime-manifest.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(LIB_DIR, '..', '..', '..');

const readRepoFile = (relPath) => readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
const readJson = (relPath) => JSON.parse(readRepoFile(relPath));

const MANIFEST = readJson('desktop/runtime-manifest.json');

/** A deep-enough clone for mutation tests. */
const clone = () => JSON.parse(JSON.stringify(MANIFEST));

describe('runtime-manifest: the shipped manifest', () => {
  it('is valid and internally consistent', () => {
    assert.equal(validateRuntimeManifest(MANIFEST), MANIFEST);
  });

  it('declares the Node major the repo requires', () => {
    assert.equal(requiredNodeMajor(MANIFEST), 24);
  });

  it('pins a Redis version for every declared target', () => {
    const versions = redisVersionsByPlatform(MANIFEST);

    assert.deepEqual(Object.keys(versions).sort(), ['darwin', 'win32']);
    assert.equal(versions.darwin, '7.4.1');
    assert.equal(versions.win32, '8.10.1');
  });

  it('derives the Windows release tag and asset name from the pin', () => {
    assert.equal(windowsRedisReleaseTag(MANIFEST), '8.10.1');
    assert.equal(windowsRedisAssetName(MANIFEST), 'Redis-8.10.1-Windows-x64-msys2.zip');
  });

  it('declares the cross-platform Redis divergence instead of hiding it', () => {
    const divergence = detectRedisDivergence(MANIFEST);

    assert.equal(divergence.diverges, true, 'the two platforms currently ship different Redis lines');
    assert.equal(divergence.declared, true, 'a divergence must be declared');
    assert.equal(divergence.id, REDIS_DIVERGENCE_ID);
  });

  it('records the divergence as a decision, not as an open question', () => {
    const entry = MANIFEST.knownDivergence.find((item) => item.id === REDIS_DIVERGENCE_ID);

    // A divergence that is merely tolerated rots into an accident. The owner
    // reviewed it and chose to keep it, so that outcome is recorded here.
    assert.ok(entry.decision, 'the accepted decision must be written down');
    assert.equal(entry.owner, undefined, 'there should be no unassigned owner left behind');
    assert.equal(entry.decisionNeeded, undefined, 'the open question must be resolved, not left open');
  });
});

describe('runtime-manifest: validator rejects incoherent manifests', () => {
  it('rejects a missing or non-object manifest', () => {
    assert.throws(() => validateRuntimeManifest(null), /missing or is not an object/);
    assert.throws(() => validateRuntimeManifest('nope'), /missing or is not an object/);
  });

  it('rejects an unknown schema version', () => {
    const manifest = clone();
    manifest.schemaVersion = 99;

    assert.throws(() => validateRuntimeManifest(manifest), /schemaVersion 99, expected 1/);
  });

  it('rejects a non-numeric Node major', () => {
    for (const bad of [undefined, '24', 0, -1, 24.5]) {
      const manifest = clone();
      manifest.node.minMajor = bad;
      assert.throws(() => validateRuntimeManifest(manifest), /node\.minMajor/, `value: ${bad}`);
    }
  });

  it('rejects an empty target list', () => {
    const manifest = clone();
    manifest.targets = [];

    assert.throws(() => validateRuntimeManifest(manifest), /targets is empty/);
  });

  it('rejects a target without a Redis version', () => {
    const manifest = clone();
    manifest.targets.push({ platform: 'linux', arch: 'x64' });

    assert.throws(() => validateRuntimeManifest(manifest), /no Redis version for platform "linux"/);
  });

  it('rejects a Windows asset template that cannot carry the version', () => {
    const manifest = clone();
    manifest.redis.win32.assetNameTemplate = 'Redis-Windows-x64-msys2.zip';

    assert.throws(() => validateRuntimeManifest(manifest), /does not contain "\{version\}"/);
  });

  it('REJECTS an undeclared cross-platform divergence', () => {
    const manifest = clone();
    manifest.knownDivergence = [];

    assert.throws(() => validateRuntimeManifest(manifest), new RegExp(`no "${REDIS_DIVERGENCE_ID}" entry is declared`));
  });

  it('accepts aligned versions with no divergence entry', () => {
    const manifest = clone();
    manifest.redis.win32.version = manifest.redis.darwin.version;
    manifest.knownDivergence = [];

    assert.equal(validateRuntimeManifest(manifest), manifest);
    assert.equal(detectRedisDivergence(manifest).diverges, false);
  });

  it('fails loudly when a platform has no pin at all', () => {
    const manifest = clone();
    delete manifest.redis.win32.version;

    assert.throws(() => redisVersionFor(manifest, 'win32'), /no Redis version for platform "win32"/);
  });
});

describe('runtime-manifest: consistency with the rest of the repo', () => {
  it('agrees with root package.json engines.node', () => {
    const engines = readJson('package.json').engines?.node ?? '';
    const match = /(\d+)/.exec(engines);

    assert.ok(match, `package.json engines.node is unreadable: ${JSON.stringify(engines)}`);
    assert.equal(
      Number(match[1]),
      requiredNodeMajor(MANIFEST),
      'package.json engines.node and runtime-manifest.json node.minMajor must agree; ' +
        'update whichever is wrong, not both.',
    );
  });

  it('keeps every CI node-version at or above the declared major', () => {
    const workflows = ['ci.yml', 'windows-smoke.yml', 'build-mac-dmg.yml', 'build-windows-desktop.yml'];
    const offenders = [];

    for (const workflow of workflows) {
      const source = readRepoFile(path.join('.github', 'workflows', workflow));
      for (const line of source.split(/\r?\n/)) {
        const match = /^\s*node-version:\s*['"]?(\d+)(?:\.(\d+))?/.exec(line);
        if (!match) continue;
        if (Number(match[1]) < requiredNodeMajor(MANIFEST)) {
          offenders.push(`${workflow}: node-version ${match[1]}`);
        }
      }
    }

    assert.deepEqual(offenders, [], 'CI must not build with a Node below the declared floor');
  });

  it('has build-mac.sh read the Redis pin instead of hardcoding it', () => {
    const source = readRepoFile(path.join('desktop', 'scripts', 'build-mac.sh'));

    assert.doesNotMatch(
      source,
      /REDIS_VERSION="\d/,
      'build-mac.sh must not hardcode a Redis version; read redis.darwin.version from the manifest',
    );
    assert.match(source, /read-runtime-manifest\.mjs/, 'build-mac.sh should use the manifest reader');
    assert.match(source, /redis\.darwin\.version/, 'build-mac.sh should read the darwin Redis pin');
  });

  it('has build-desktop.ps1 pin the Windows Redis release', () => {
    const source = readRepoFile(path.join('desktop', 'scripts', 'build-desktop.ps1'));

    assert.match(source, /runtime-manifest\.json/, 'build-desktop.ps1 should read the manifest');
    assert.match(source, /redis\.win32\.version/, 'build-desktop.ps1 should read the win32 Redis pin');
    // Asserting the positive property (the endpoint is built from the pin) is
    // stronger than banning a word: a comment may mention the old behaviour.
    assert.match(
      source,
      /releases\/tags\/\$redisVersion/,
      'the Redis download must target the pinned release tag rather than a moving "latest"',
    );
  });

  it('states the same Node floor in the desktop README', () => {
    const source = readRepoFile(path.join('desktop', 'README.md'));
    const major = requiredNodeMajor(MANIFEST);

    assert.match(
      source,
      new RegExp(`Node\\.js\\*\\*\\s*≥\\s*${major}`),
      `desktop/README.md should state the Node requirement as >= ${major}`,
    );
  });
});
