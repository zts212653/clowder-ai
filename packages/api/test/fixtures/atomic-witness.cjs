'use strict';

// Test fixtures publish a witness file that another process polls with
// `existsSync(...)` and then parses immediately. `writeFileSync` truncates the
// target before writing it, so the observable path passes through an empty or
// half-written state: the reader parses garbage and the suite goes red for a
// reason that has nothing to do with the code under test.
//
// Publishing through a sibling temp file plus `renameSync` removes that state
// entirely — on a single filesystem the rename is atomic, so the target either
// does not exist or holds a complete document. An interrupted publish leaves
// the temp file, never a damaged target, and the temp file is removed on exit.

const { renameSync, rmSync, writeFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');

const pendingTempFiles = new Set();
let cleanupRegistered = false;

function removeTempFile(tempPath) {
  pendingTempFiles.delete(tempPath);
  try {
    rmSync(tempPath, { force: true });
  } catch {
    // An unreadable temp file must never mask the fixture's real outcome.
  }
}

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  // Only `exit`. Deliberately no SIGINT/SIGTERM/SIGHUP handlers: the fixtures
  // that publish witnesses exist to be cancelled and killed, and installing
  // handlers would replace signal death with a normal exit — perturbing the
  // very semantics those suites assert. A signal-killed publish leaves its
  // temp file in the caller's temp directory, which is harmless; the invariant
  // that matters is that the target is never damaged, and rename guarantees
  // that with no handler at all.
  process.on('exit', () => {
    for (const tempPath of [...pendingTempFiles]) removeTempFile(tempPath);
  });
}

/**
 * Publish `value` at `targetPath` so no reader can ever observe a partial document.
 * @returns {string} the published target path
 */
function publishWitness(targetPath, value) {
  registerCleanup();
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  pendingTempFiles.add(tempPath);
  try {
    writeFileSync(tempPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tempPath, targetPath);
    pendingTempFiles.delete(tempPath);
  } catch (error) {
    removeTempFile(tempPath);
    throw error;
  }
  return targetPath;
}

module.exports = { publishWitness };
