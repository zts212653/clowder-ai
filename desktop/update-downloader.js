// F257: Desktop In-App Update — download & journal layer
//
// This module handles:
//   1. pendingUpdate journal — crash-safe state machine for upgrade tracking
//   2. File integrity verification (sha256 digest + size)
//   3. Updates directory management
//
// HTTP download logic lives in the Electron integration layer (update-manager.js,
// Phase B/C) because it requires Electron's `net` module for system proxy support.
//
// Design decisions (from spec):
//   - Journal at {userData}/updates/pending-update.json
//   - Installer + log MUST stay in {userData}/updates/ (never temp!)
//   - Failed state: never auto-clean (user may need to rerun installer manually)
//   - Success state: clear journal + clean old files
//   - Digest format: "sha256:{hex}" from GitHub API

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { compareSemver } = require('./update-checker');

const JOURNAL_FILENAME = 'pending-update.json';

/**
 * Get the updates directory path for a given userData root.
 * @param {string} userDataRoot
 * @returns {string}
 */
function updatesDir(userDataRoot) {
  return path.join(userDataRoot, 'updates');
}

// ── Journal persistence ────────────────────────────────────────────────
// The journal is a small JSON file that records the state of a pending upgrade.
// It is written BEFORE spawning the installer and checked on next startup.
//
// State machine (spec §3.2):
//   spawn → write journal → quit → installer runs → next startup:
//     current >= target → "success" (clear journal, notify user)
//     current <  target → "failed"  (show recovery dialog)

/**
 * Write a pending update journal entry.
 * Creates the directory if needed.
 *
 * @param {string} dir — directory to write journal in (typically updatesDir)
 * @param {object} data
 * @param {string} data.targetVersion
 * @param {number} data.assetId
 * @param {string} data.assetName
 * @param {string} data.digest
 * @param {string} data.installerPath
 * @param {string} data.logPath
 * @param {string} data.startedAt — ISO8601 timestamp
 */
function writeJournal(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const journalPath = path.join(dir, JOURNAL_FILENAME);
  fs.writeFileSync(journalPath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Read the pending update journal. Returns null if missing or corrupt.
 * @param {string} dir
 * @returns {object | null}
 */
function readJournal(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, JOURNAL_FILENAME), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Clear the journal (upgrade succeeded or user chose "ignore").
 * Safe to call when no journal exists.
 * @param {string} dir
 */
function clearJournal(dir) {
  try {
    fs.unlinkSync(path.join(dir, JOURNAL_FILENAME));
  } catch {
    // file didn't exist — fine
  }
}

/**
 * Check the result of a previous upgrade attempt.
 *
 * @param {string} dir — journal directory
 * @param {string} currentVersion — app.getVersion() at startup
 * @returns {'none' | 'success' | 'failed'}
 */
function checkUpgradeResult(dir, currentVersion) {
  const journal = readJournal(dir);
  if (!journal) return 'none';
  try {
    // current >= target means upgrade succeeded
    if (compareSemver(currentVersion, journal.targetVersion) >= 0) {
      return 'success';
    }
    return 'failed';
  } catch {
    // Invalid version in journal — treat as no journal
    return 'none';
  }
}

// ── File integrity verification ────────────────────────────────────────

/**
 * Verify a downloaded file's integrity against the expected digest and size.
 * Uses streaming SHA256 (spec §2: "node:crypto streaming sha256").
 *
 * @param {string} filePath — path to the downloaded file
 * @param {string} expectedDigest — e.g. "sha256:abc123..."
 * @param {number} expectedSize — expected byte count
 * @returns {boolean}
 */
function verifyFileIntegrity(filePath, expectedDigest, expectedSize) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size !== expectedSize) return false;

    // Parse digest format "sha256:{hex}"
    const colonIdx = expectedDigest.indexOf(':');
    if (colonIdx === -1) return false;
    const expectedHash = expectedDigest.slice(colonIdx + 1);

    const content = fs.readFileSync(filePath);
    const actualHash = createHash('sha256').update(content).digest('hex');
    return actualHash === expectedHash;
  } catch {
    return false;
  }
}

module.exports = {
  JOURNAL_FILENAME,
  updatesDir,
  writeJournal,
  readJournal,
  clearJournal,
  checkUpgradeResult,
  verifyFileIntegrity,
};
