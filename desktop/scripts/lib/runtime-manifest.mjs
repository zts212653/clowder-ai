/**
 * Reader and validator for desktop/runtime-manifest.json.
 *
 * The desktop runtime facts used to be repeated across build-mac.sh,
 * build-desktop.ps1, the CI workflows, package.json engines and the README,
 * which is how they drifted apart: the README asked for Node >= 20 while the
 * repo required >= 24, and Windows resolved Redis through its repository's most
 * recent release (a moving target) while macOS pinned 7.4.1.
 *
 * The manifest is now the declaration, and runtime-manifest.test.mjs is the
 * guard that fails when any of those places disagree with it.
 *
 * Pure logic only — no filesystem access — so it is unit-testable anywhere.
 * The CLI wrapper that print scripts use lives in read-runtime-manifest.mjs.
 */

/** Divergence id that must be declared when platforms ship different Redis. */
const REDIS_DIVERGENCE_ID = 'redis-version-across-platforms';

function fail(what, why, fix) {
  throw new Error(`${what}\n  why: ${why}\n  fix: ${fix}`);
}

/** Read a dotted path out of a plain object. */
function getByPath(object, dottedPath) {
  if (!dottedPath) return object;
  return String(dottedPath)
    .split('.')
    .reduce((current, key) => (current == null ? undefined : current[key]), object);
}

function assertManifestObject(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    fail(
      'runtime-manifest.json is missing or is not an object.',
      'every desktop build script reads its versions from this file.',
      'restore desktop/runtime-manifest.json from version control.',
    );
  }
}

function assertSchemaVersion(manifest) {
  if (manifest.schemaVersion !== 1) {
    fail(
      `runtime-manifest.json has schemaVersion ${JSON.stringify(manifest.schemaVersion)}, expected 1.`,
      'the reader only understands schema version 1.',
      'either update the file or extend the reader before bumping the schema.',
    );
  }
}

function assertNodeMajor(manifest) {
  if (!Number.isInteger(manifest.node?.minMajor) || manifest.node.minMajor <= 0) {
    fail(
      `runtime-manifest.json node.minMajor is ${JSON.stringify(manifest.node?.minMajor)}.`,
      'the bundled portable Node must clear a numeric major floor.',
      'set node.minMajor to a positive integer, e.g. 24.',
    );
  }
}

function assertTargetsPresent(manifest) {
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    fail(
      'runtime-manifest.json targets is empty.',
      'the installer ships per-platform runtimes and needs at least one target.',
      'add at least one { "platform": "...", "arch": "..." } entry.',
    );
  }
}

function assertTargetHasRedis(manifest, target) {
  if (!target?.platform || !target?.arch) {
    fail(
      `runtime-manifest.json has a target without platform/arch: ${JSON.stringify(target)}.`,
      'targets are matched by platform and arch.',
      'give every target both a platform and an arch.',
    );
  }
  if (!manifest.redis?.[target.platform]?.version) {
    fail(
      `runtime-manifest.json declares no Redis version for platform "${target.platform}".`,
      'a target without a Redis version would make the build guess.',
      `add redis.${target.platform}.version.`,
    );
  }
}

function assertWindowsAssetTemplate(manifest) {
  const windowsRedis = manifest.redis?.win32;
  if (windowsRedis && !String(windowsRedis.assetNameTemplate ?? '').includes('{version}')) {
    fail(
      'runtime-manifest.json redis.win32.assetNameTemplate does not contain "{version}".',
      'the Windows build substitutes the pinned version into the release asset name.',
      'use a template such as "Redis-{version}-Windows-x64-msys2.zip".',
    );
  }
}

/** The one status value that means "declared, but nobody has decided this yet". */
const PENDING_DECISION_STATUS = 'pending_maintainer_decision';

/** Whether a reader who only has this repo can resolve the reference. */
function isRepoQualifiedReference(reference) {
  return /^https?:\/\//i.test(reference) || /^[\w.-]+\/[\w.-]+#\d+$/.test(reference);
}

/** Whether an entry claims that somebody has already reached a decision. */
function assertsDecisionReached(entry) {
  return Boolean(entry.decision) || (entry.status != null && entry.status !== PENDING_DECISION_STATUS);
}

/** Provenance rules for a single knownDivergence entry. */
function assertEntryProvenance(entry) {
  const id = entry.id ?? '(entry without id)';
  const reference = entry.decidedIn == null ? null : String(entry.decidedIn);
  const pending = entry.status === PENDING_DECISION_STATUS;

  if (reference !== null && !isRepoQualifiedReference(reference)) {
    fail(
      `runtime-manifest.json records a decision for "${id}" with decidedIn ${JSON.stringify(entry.decidedIn)}.`,
      'a bare issue or PR number resolves differently in every repository, so no reader can verify the decision.',
      'use a repository-qualified reference such as "owner/repo#123" or a full URL, or mark the entry as pending instead of decided.',
    );
  }

  if (reference === null && assertsDecisionReached(entry)) {
    fail(
      `runtime-manifest.json entry "${id}" asserts a decision (status ${JSON.stringify(entry.status ?? null)}) but cites no decidedIn.`,
      'a decision nobody can look up is indistinguishable from an assumption, which is how an invalid one shipped before.',
      `add decidedIn as "owner/repo#123" or a full URL, or set status to "${PENDING_DECISION_STATUS}".`,
    );
  }

  if (pending && (entry.decision || reference !== null)) {
    fail(
      `runtime-manifest.json entry "${id}" is marked "${PENDING_DECISION_STATUS}" but also carries a decision.`,
      'the two say opposite things, and whichever a reader believes, one of them is wrong.',
      `drop the decision fields, or change status to reflect the state that was actually reached.`,
    );
  }
}

/**
 * A decision must be verifiable by a reader who only has THIS repo.
 *
 * A bare "#123" resolves differently in every repository — clowder-ai#11 is not a
 * fork's PR #11 — so it is not provenance at all. This rule exists because exactly
 * that mistake shipped once and was caught in upstream review.
 *
 * It keys off every field that can assert a decision, not off `decision` alone.
 * The first version checked only `decision`, which this manifest had already
 * stopped using — it records `status` — so the guard passed on the shipped file
 * while checking nothing, and a later `status: "accepted"` with a bare number
 * would have sailed through the very check written to stop it.
 */
function assertDivergenceProvenance(manifest) {
  for (const entry of manifest.knownDivergence ?? []) {
    if (entry && typeof entry === 'object') assertEntryProvenance(entry);
  }
}

/**
 * Validate the manifest's shape.
 *
 * Deliberately does not check cross-platform divergence: that check needs
 * detectRedisDivergence(), which needs the shape to be readable first. Folding
 * the two together makes them call each other forever.
 */
function validateRuntimeShape(manifest) {
  assertManifestObject(manifest);
  assertSchemaVersion(manifest);
  assertNodeMajor(manifest);
  assertTargetsPresent(manifest);
  for (const target of manifest.targets) assertTargetHasRedis(manifest, target);
  assertWindowsAssetTemplate(manifest);
  assertDivergenceProvenance(manifest);
  return manifest;
}

/**
 * Validate the manifest shape and its internal consistency.
 *
 * @returns the manifest, so callers can validate-and-use in one expression.
 */
function validateRuntimeManifest(manifest) {
  validateRuntimeShape(manifest);

  // A divergence between platforms must be declared, never accidental: the two
  // installers write Redis data that users keep.
  const divergence = detectRedisDivergence(manifest);
  if (divergence.diverges && !divergence.declared) {
    fail(
      `Redis versions differ across platforms (${Object.entries(divergence.versions)
        .map(([platform, version]) => `${platform}=${version}`)
        .join(', ')}) but no "${REDIS_DIVERGENCE_ID}" entry is declared.`,
      'shipping different Redis lines per platform changes the on-disk data format, which is a product decision.',
      `add a knownDivergence entry with id "${REDIS_DIVERGENCE_ID}", or align the versions.`,
    );
  }

  return manifest;
}

/** The Node major every bundled runtime must clear. */
function requiredNodeMajor(manifest) {
  return validateRuntimeManifest(manifest).node.minMajor;
}

/**
 * Redis versions keyed by platform, for the targets the manifest declares.
 * A pure projection: it never validates, so the divergence rule can use it.
 */
function redisVersionsByPlatform(manifest) {
  const versions = {};
  for (const target of manifest?.targets ?? []) {
    const version = manifest?.redis?.[target.platform]?.version;
    if (version) versions[target.platform] = version;
  }
  return versions;
}

/** Whether the declared platforms ship different Redis versions, and if so, whether that is declared. */
function detectRedisDivergence(manifest) {
  const versions = redisVersionsByPlatform(manifest);
  const distinct = new Set(Object.values(versions));
  const divergenceId = REDIS_DIVERGENCE_ID;
  const declared = (manifest?.knownDivergence ?? []).some((entry) => entry?.id === divergenceId);
  return { diverges: distinct.size > 1, versions, declared, id: divergenceId };
}

/** The pinned Redis version for a platform. */
function redisVersionFor(manifest, platform) {
  validateRuntimeManifest(manifest);
  const version = manifest.redis?.[platform]?.version;
  if (!version) {
    fail(
      `runtime-manifest.json declares no Redis version for platform "${platform}".`,
      'the build cannot pin what it does not know.',
      `add redis.${platform}.version.`,
    );
  }
  return version;
}

/** Release tag to fetch from the redis-windows repository. */
function windowsRedisReleaseTag(manifest) {
  return redisVersionFor(manifest, 'win32');
}

/** Release asset name for the pinned Windows Redis build. */
function windowsRedisAssetName(manifest) {
  const version = redisVersionFor(manifest, 'win32');
  return manifest.redis.win32.assetNameTemplate.replaceAll('{version}', version);
}

export {
  detectRedisDivergence,
  getByPath,
  PENDING_DECISION_STATUS,
  REDIS_DIVERGENCE_ID,
  redisVersionFor,
  redisVersionsByPlatform,
  requiredNodeMajor,
  validateRuntimeManifest,
  validateRuntimeShape,
  windowsRedisAssetName,
  windowsRedisReleaseTag,
};
