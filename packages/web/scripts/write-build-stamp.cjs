#!/usr/bin/env node
// Record the revision `next build` just produced, next to the bundle it describes.
//
// The API publishes a deployment revision only when packages/api/dist/.build-commit
// and packages/web/.next/.build-commit agree (packages/api/src/config/
// runtime-deployment-revision.ts). A missing Web stamp makes it publish null, which
// leaves every production browser document read-only with no recoverable refresh.
//
// This runs as `postbuild` rather than from a launcher because `next build` wipes
// and recreates .next: any stamp a launcher wrote beforehand is destroyed, and only
// the build's own lifecycle is guaranteed to run for every caller.
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { WEB_PACKAGE_DIR, resolveWebBuildRevision } = require('./build-revision.cjs');

const DIST_DIR_NAME = '.next';
const STAMP_FILE_NAME = '.build-commit';

function buildStampPath(webPackageDir = WEB_PACKAGE_DIR) {
  return path.join(webPackageDir, DIST_DIR_NAME, STAMP_FILE_NAME);
}

function writeBuildStamp({ webPackageDir = WEB_PACKAGE_DIR, ...revisionOptions } = {}) {
  const revision = resolveWebBuildRevision(revisionOptions);
  // Never invent deployment identity: an unstamped build fails closed, a wrongly
  // stamped one ships incompatible clients as if they matched.
  if (!revision) return null;
  const stampPath = buildStampPath(webPackageDir);
  mkdirSync(path.dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, `${revision}\n`, 'utf8');
  return stampPath;
}

module.exports = { DIST_DIR_NAME, STAMP_FILE_NAME, buildStampPath, writeBuildStamp };

if (require.main === module) {
  // Best-effort, mirroring record_build_stamp in scripts/lib/quickstart-freshness.sh:
  // a non-git deploy must still be able to build.
  if (!writeBuildStamp()) {
    console.warn(
      '[web] build revision unavailable; skipped .next/.build-commit (runtime deployment guard will fail closed)',
    );
  }
}
