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
  PENDING_DECISION_STATUS,
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

  it('marks the divergence as pending maintainer decision, not as settled', () => {
    const entry = MANIFEST.knownDivergence.find((item) => item.id === REDIS_DIVERGENCE_ID);

    // An earlier revision of this file recorded the divergence as decided and
    // cited a bare "#11". That number means different things in different
    // repositories, so it was not evidence of any decision — nobody here has
    // the authority to settle a cross-platform data-format question anyway.
    // The honest state is "declared, pinned, awaiting the maintainer".
    assert.equal(entry.status, PENDING_DECISION_STATUS);
    assert.equal(entry.decision, undefined, 'no decision has been made, so none may be recorded');
    assert.equal(entry.decidedIn, undefined, 'with no decision there is no provenance to cite');
    assert.ok(entry.proposal, 'a pending item must still say what we propose');
    assert.ok(entry.riskOfUnifying, 'and why unifying is not a mechanical change');
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

  // Provenance is only provenance if a reader can resolve it. "#11" cannot:
  // clowder-ai#11 and a fork's PR #11 are different objects, and an upstream
  // reviewer caught exactly this in a shipped decision record.
  //
  // The first version of these cases set only `decision`. That made them pass
  // against a guard which checked only `decision` — a field this manifest had
  // already stopped using — so both the guard and its tests were validating a
  // shape nobody writes any more. Every case below now covers the status shape too.
  it('REJECTS a decision cited by bare number', () => {
    for (const bad of ['#11', 'PR #11', '11', 'see the linked PR']) {
      for (const claim of [
        { decision: 'keep the pins' },
        { status: 'accepted' },
        { status: 'accepted', decision: 'keep the pins' },
      ]) {
        const manifest = clone();
        Object.assign(manifest.knownDivergence[0], claim, { decidedIn: bad });

        assert.throws(
          () => validateRuntimeManifest(manifest),
          /bare issue or PR number resolves differently/,
          `reference: ${bad}, claim: ${JSON.stringify(claim)}`,
        );
      }
    }
  });

  it('REJECTS a settled status that cites nothing at all', () => {
    for (const status of ['accepted', 'decided', 'settled_by_owner']) {
      const manifest = clone();
      manifest.knownDivergence[0].status = status;
      delete manifest.knownDivergence[0].decidedIn;

      assert.throws(
        () => validateRuntimeManifest(manifest),
        /asserts a decision .* but cites no decidedIn/,
        `status: ${status}`,
      );
    }
  });

  it('REJECTS an entry marked pending that also carries a decision', () => {
    const manifest = clone();
    manifest.knownDivergence[0].status = PENDING_DECISION_STATUS;
    manifest.knownDivergence[0].decidedIn = 'zts212653/clowder-ai#1459';

    assert.throws(() => validateRuntimeManifest(manifest), /but also carries a decision/);
  });

  it('ACCEPTS a repository-qualified decision reference', () => {
    for (const good of ['zts212653/clowder-ai#123', 'https://github.com/zts212653/clowder-ai/pull/123']) {
      const manifest = clone();
      manifest.knownDivergence[0].status = 'accepted';
      manifest.knownDivergence[0].decidedIn = good;

      assert.equal(validateRuntimeManifest(manifest), manifest, `reference: ${good}`);
    }
  });

  it('does not require provenance for an entry that declares no decision', () => {
    const manifest = clone();
    const entry = manifest.knownDivergence[0];

    assert.equal(entry.status, PENDING_DECISION_STATUS, 'the shipped entry is the pending shape');
    assert.equal(entry.decision, undefined);
    assert.equal(entry.decidedIn, undefined);
    assert.equal(validateRuntimeManifest(manifest), manifest);
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

  // The field and the script that needs it were once disconnected: the manifest
  // declared `assetNameTemplate`, nothing but a unit test read it, and the Windows
  // build composed the pattern from its own literal. Renaming the upstream asset
  // then meant editing the manifest AND the script — and editing only the manifest
  // kept every test green while the build kept asking for the old name. These two
  // assertions are what make "one source of truth" checkable rather than claimed.
  it('has build-desktop.ps1 take the Windows asset pattern from the manifest', () => {
    const source = readRepoFile(path.join('desktop', 'scripts', 'build-desktop.ps1'));

    assert.doesNotMatch(
      source,
      /Windows-x64-msys2/,
      'build-desktop.ps1 must not carry its own copy of the Redis asset-name shape; read redis.win32.assetNameTemplate',
    );
    assert.match(
      source,
      /assetNameTemplate/,
      'build-desktop.ps1 should read the asset-name template from the manifest',
    );
    assert.match(
      source,
      /read-runtime-manifest\.mjs/,
      'build-desktop.ps1 should read through the manifest reader, so validateRuntimeManifest applies to it',
    );
  });

  it('has build-mac.sh fail closed on the host Node, matching the Windows rule', () => {
    const source = readRepoFile(path.join('desktop', 'scripts', 'build-mac.sh'));

    // It used to warn and substitute a hardcoded version, which is the same defect
    // the Windows build had: the bundled Node must match the Node that compiled the
    // native modules, so a guess ships a DMG whose API dies on load.
    assert.doesNotMatch(
      source,
      /defaulting to v\d/,
      'build-mac.sh must not default to a hardcoded Node version when node is missing',
    );
    assert.match(source, /die "node not on PATH/, 'build-mac.sh should die when node is not on PATH');

    // The first version of that message asked node to read the required major — on
    // the one branch where node is by definition absent. It printed
    // "install Node >=  " plus a "command not found". A fix that needs the very
    // thing it is telling you to install is not a fix.
    assert.doesNotMatch(
      source,
      /die\s+"[^"]*\$\(node\s/,
      'a failure message must not need node to describe how to fix the missing node',
    );

    // And the floor has to be enforced, not merely mentioned: the Windows build
    // throws below engines.node, and a host that is too old bundles a portable Node
    // this project does not support.
    assert.match(
      source,
      /-lt "\$REQUIRED_NODE_MAJOR"/,
      'build-mac.sh should compare the host Node major against the declared floor',
    );
    // `[[ 22 -lt "not-a-number" ]]` prints an arithmetic error and evaluates FALSE,
    // so without this the gate would skip itself and continue — fail-open. The
    // manifest reader rejects a non-numeric node.minMajor, but the comparison must
    // not depend on that guarantee to stay safe.
    assert.match(
      source,
      /\[\[ "\$REQUIRED_NODE_MAJOR" =~ \^\[0-9\]\+\$ \]\]/,
      'the floor must be validated as numeric before it is compared',
    );
    assert.match(
      source,
      /read-runtime-manifest\.mjs" node\.minMajor/,
      'the floor should come from the manifest, which the test above keeps equal to package.json engines.node',
    );
  });
});
