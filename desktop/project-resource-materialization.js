const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  lstat,
  readTree,
  sameTree,
  readMarker,
  assertUnchanged,
  inspectManaged,
  stageTree,
} = require('./project-resource-tree');

const PHYSICAL_RESOURCES = new Set(['docs', 'cat-cafe-skills', 'assets', 'guides']);

function retainInterruptedStage(stage, mirror, log) {
  if (!lstat(stage)) return;
  // A crash may leave an incomplete write. Retain it rather than deleting
  // unexpected content; the next launch can still retry from a fresh stage.
  if (!readMarker(stage, mirror)) throw new Error(`Preserving unowned resource staging directory: ${stage}`);
  const retained = `${stage}.interrupted-${crypto.randomUUID()}`;
  fs.renameSync(stage, retained);
  log(`Retained interrupted bundled resource staging: ${retained}`);
}

function retirePrevious(previous, mirror, log) {
  if (!lstat(previous)) return;
  assertUnchanged(previous, mirror);
  // Never partially delete a directory occupying a recovery slot. A crash or
  // sharing violation during cleanup must not poison the next publication.
  const retired = `${previous}.retired-${crypto.randomUUID()}`;
  fs.renameSync(previous, retired);
  try {
    fs.rmSync(retired, { recursive: true });
  } catch (error) {
    log(`Retained retired bundled resource backup ${retired}: code=${error.code ?? 'UNKNOWN'}`);
  }
}

// Called synchronously before services start, under Desktop's single-instance lock.
// Reserved siblings never contain configuration/history. Existing real roots
// without our marker remain owner data and cannot be adopted automatically.
function materializeResource({ source, destination, installRoot, mirror, removeLink, log }) {
  const started = Date.now();
  const stage = path.join(path.dirname(destination), `.clowder-resource-${mirror}.next`);
  const previous = path.join(path.dirname(destination), `.clowder-resource-${mirror}.previous`);
  if (!lstat(destination) && lstat(previous)) {
    assertUnchanged(previous, mirror);
    fs.renameSync(previous, destination);
    log(`Restored interrupted bundled resource publication: ${destination}`);
  }
  const existing = lstat(destination);
  if (existing && !existing.isSymbolicLink() && !readMarker(destination, mirror)) {
    log(`Preserving existing non-link mirror ${destination}: unmanaged owner directory`);
    return;
  }
  const entries = readTree(source, { boundary: fs.realpathSync(installRoot) });
  if (existing && !existing.isSymbolicLink()) {
    const { marker, hasOwnerEntries } = inspectManaged(destination, mirror);
    if (sameTree(marker.entries, entries)) {
      log(`Bundled resource verified: ${destination} (${entries.length} entries, ${Date.now() - started}ms)`);
      return;
    }
    if (hasOwnerEntries) {
      log(
        `Preserving extended resource directory ${destination}: bundled refresh deferred; owner files remain in place`,
      );
      return;
    }
  }
  retainInterruptedStage(stage, mirror, log);
  stageTree({ source, stage, mirror, boundary: fs.realpathSync(installRoot), entries });
  retirePrevious(previous, mirror, log);
  if (existing?.isSymbolicLink()) {
    removeLink(destination); // Never traverse, chmod or remove its target.
  } else if (existing) {
    assertUnchanged(destination, mirror);
    fs.renameSync(destination, previous);
  }
  try {
    fs.renameSync(stage, destination);
  } catch (error) {
    if (!lstat(destination) && lstat(previous)) fs.renameSync(previous, destination);
    throw error;
  }
  log(`Bundled resource materialized: ${destination} (${entries.length} entries, ${Date.now() - started}ms)`);
}

module.exports = { PHYSICAL_RESOURCES, materializeResource };
