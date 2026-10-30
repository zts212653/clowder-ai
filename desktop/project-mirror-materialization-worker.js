const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  MARKER,
  MIRRORS,
  hash,
  canonical,
  check,
  inventory,
  markerAt,
  entryState,
  verifyEntry,
  removeGeneratedTree,
} = require('./project-mirror-resource-state');

const JOURNAL = '.clowder-resource-transaction.json';

function exists(filename) {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeOwnedStaticTree(root, journal, deadline) {
  verifyEntry(root, journal.source, journal.mirror, journal.before, deadline);
  const holding = path.join(root, `.clowder-cleanup-${crypto.randomUUID()}`);
  fs.mkdirSync(holding);
  for (const record of journal.before.marker.value.records.filter((entry) => entry.kind === 'file')) {
    check(deadline);
    const filename = path.join(root, record.path);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(filename)) !== record.sha256)
      throw new Error(`Preserving changed retired resource: ${filename}`);
    const held = path.join(holding, path.basename(record.path));
    fs.renameSync(filename, held);
    // Verify the entry actually moved before deleting it. A concurrently
    // replaced owner file is restored, or retained alongside a new owner file.
    const moved = fs.lstatSync(held);
    if (!moved.isFile() || moved.isSymbolicLink() || hash(fs.readFileSync(held)) !== record.sha256) {
      if (!exists(filename)) fs.renameSync(held, filename);
      throw new Error(`Preserving changed retired resource in ${root}`);
    }
    fs.unlinkSync(held);
  }
  fs.rmdirSync(holding);
  const directories = journal.before.marker.value.records
    .filter((entry) => entry.kind === 'directory')
    .sort((left, right) => right.path.length - left.path.length);
  // rmdir refuses nonempty directories; unknown additions are never visited.
  for (const { path: relative } of directories) fs.rmdirSync(path.join(root, relative));
  const names = fs.readdirSync(root);
  if (names.length !== 1 || names[0] !== MARKER) throw new Error(`Preserving owner additions in ${root}`);
  const marker = markerAt(root);
  if (marker?.text !== journal.before.marker.text) throw new Error(`Preserving changed retired marker in ${root}`);
  fs.unlinkSync(path.join(root, MARKER));
  fs.rmdirSync(root);
}

function removeBackup(filename, journal, deadline) {
  verifyEntry(filename, journal.source, journal.mirror, journal.before, deadline);
  if (fs.lstatSync(filename).isSymbolicLink()) {
    if (process.platform === 'win32') fs.rmdirSync(filename);
    else fs.unlinkSync(filename);
  } else {
    // Cleanup must never leave a partially deleted tree in a recovery slot.
    // A retired static copy is outside the journal; failure preserves it.
    const retired = `${filename}.retired-${crypto.randomUUID()}`;
    fs.renameSync(filename, retired);
    try {
      removeOwnedStaticTree(retired, journal, deadline);
    } catch {
      return retired;
    }
  }
}

function readJournal(projectDir) {
  const journalPath = path.join(projectDir, JOURNAL);
  if (!exists(journalPath)) return null;
  if (!fs.lstatSync(journalPath).isFile() || fs.lstatSync(journalPath).isSymbolicLink())
    throw new Error('Resource recovery journal is not a regular file');
  if (fs.lstatSync(journalPath).size > 4 * 1024 * 1024) throw new Error('Resource recovery journal is too large');
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  } catch {
    throw new Error('Invalid resource recovery journal JSON');
  }
  if (
    journal.schemaVersion !== 1 ||
    !MIRRORS.has(journal.mirror) ||
    !/^[a-f0-9-]{36}$/.test(journal.id) ||
    !journal.before?.identity ||
    typeof journal.source !== 'string' ||
    !journal.marker?.records ||
    hash(JSON.stringify(journal.marker.records)) !== journal.marker.digest
  )
    throw new Error('Invalid resource recovery journal');
  const prefix = `.clowder-resource-${journal.id}`;
  return {
    ...journal,
    journalPath,
    destination: path.join(projectDir, journal.mirror),
    stage: path.join(projectDir, `${prefix}.stage`),
    backup: path.join(projectDir, `${prefix}.previous`),
  };
}

function verifyPartialStage(journal, deadline) {
  const markerPath = path.join(journal.stage, MARKER);
  if (exists(markerPath)) {
    if (
      !fs.lstatSync(markerPath).isFile() ||
      fs.lstatSync(markerPath).isSymbolicLink() ||
      fs.lstatSync(markerPath).size > 4 * 1024 * 1024
    )
      throw new Error('Interrupted resource marker was modified');
    if (!JSON.stringify(journal.marker).startsWith(fs.readFileSync(markerPath, 'utf8')))
      throw new Error('Interrupted resource marker was modified');
  }
  const expected = new Map(journal.marker.records.map((record) => [record.path, record]));
  for (const actual of inventory(journal.stage, { deadline, excludeMarker: true }).records) {
    const record = expected.get(actual.path);
    if (!record || record.kind !== actual.kind)
      throw new Error(`Interrupted resource stage has unknown owner files; preserving ${journal.stage}`);
    if (record.kind === 'file' && actual.sha256 !== record.sha256) {
      const source = fs.readFileSync(path.join(journal.source, actual.path));
      const partial = fs.readFileSync(path.join(journal.stage, actual.path));
      if (hash(source) !== record.sha256 || !partial.equals(source.subarray(0, partial.length)))
        throw new Error(`Interrupted resource stage was modified; preserving ${journal.stage}`);
    }
  }
}

function recoverInterrupted(projectDir, deadline) {
  const journal = readJournal(projectDir);
  if (!journal) return [];
  const retained = [];
  const { destination, stage, backup, journalPath } = journal;
  if (exists(backup)) {
    if (!exists(destination)) fs.renameSync(backup, destination);
    else {
      const marker = markerAt(destination);
      if (
        !marker ||
        marker.value.transactionId !== journal.id ||
        inventory(destination, { deadline, excludeMarker: true }).digest !== marker.value.digest
      ) {
        throw new Error(
          `Interrupted resource recovery has a conflicting destination; preserving all files: ${destination}`,
        );
      }
      const retired = removeBackup(backup, journal, deadline);
      if (retired) retained.push(retired);
    }
  }
  if (exists(stage)) {
    verifyPartialStage(journal, deadline);
    removeGeneratedTree(stage);
  }
  fs.unlinkSync(journalPath);
  return retained;
}

function materializeOne({ installRoot, projectDir, mirror, deadline, allowLink }) {
  const source = path.join(installRoot, mirror);
  const destination = path.join(projectDir, mirror);
  const before = entryState(destination, source, mirror, deadline);
  if (before.identity.link && !allowLink) return { mirror, status: 'link' };
  const sourceInventory = inventory(source, { deadline });
  if (before.marker?.value.digest === sourceInventory.digest) return { mirror, status: 'current' };
  if (before.hasOwnerEntries) return { mirror, status: 'refresh deferred', reason: 'owner additions retained' };
  const id = crypto.randomUUID();
  const journalPath = path.join(projectDir, JOURNAL);
  const stage = path.join(projectDir, `.clowder-resource-${id}.stage`);
  const backup = path.join(projectDir, `.clowder-resource-${id}.previous`);
  const marker = {
    schemaVersion: 1,
    mirror,
    digest: sourceInventory.digest,
    records: sourceInventory.records,
    transactionId: id,
  };
  const journal = { schemaVersion: 1, id, mirror, source, before, marker };
  fs.writeFileSync(journalPath, JSON.stringify(journal), { flag: 'wx' });
  fs.mkdirSync(stage);
  // An ownership marker is present even during a partial copy so cancellation is recoverable.
  fs.writeFileSync(path.join(stage, MARKER), JSON.stringify(marker));
  try {
    const copied = inventory(source, { deadline, copyTo: stage });
    if (
      copied.digest !== sourceInventory.digest ||
      inventory(stage, { deadline, excludeMarker: true }).digest !== sourceInventory.digest ||
      inventory(source, { deadline }).digest !== sourceInventory.digest
    ) {
      throw new Error(`Managed resource source or staged content changed during copy: ${source}`);
    }
    check(deadline);
    verifyEntry(destination, source, mirror, before, deadline);
    fs.renameSync(destination, backup);
    try {
      // Recheck the entry actually moved, closing the check/rename replacement window.
      verifyEntry(backup, source, mirror, before, deadline);
      fs.renameSync(stage, destination);
    } catch (error) {
      fs.renameSync(backup, destination);
      throw error;
    }
    const retainedBackup = removeBackup(backup, journal, deadline);
    fs.unlinkSync(journalPath);
    return {
      mirror,
      status: 'materialized',
      files: copied.records.filter((entry) => entry.kind === 'file').length,
      bytes: copied.bytes,
      digest: copied.digest,
      ...(retainedBackup ? { retainedBackup } : {}),
    };
  } catch (error) {
    // Recover only our recorded stage/link; unknown or concurrently changed owner data stays intact.
    try {
      const retained = recoverInterrupted(projectDir, deadline);
      if (retained.length) error.message += `; retained static backups: ${retained.join(', ')}`;
    } catch (recoveryError) {
      error.message += `; recovery retained for retry: ${recoveryError.message}`;
    }
    throw error;
  }
}

function runRequest(request) {
  const { installRoot, projectDir, mirrors, allowLink = false, budgetMs = 60000 } = request;
  if (
    typeof installRoot !== 'string' ||
    typeof projectDir !== 'string' ||
    !Array.isArray(mirrors) ||
    mirrors.some((mirror) => !MIRRORS.has(mirror)) ||
    canonical(installRoot) === canonical(projectDir)
  )
    throw new Error('Invalid managed resource recovery request');
  const deadline = Date.now() + Math.min(60000, Math.max(1, budgetMs));
  const retained = recoverInterrupted(projectDir, deadline);
  return [
    ...retained.map((retainedBackup) => ({ status: 'retained retired backup', retainedBackup })),
    ...mirrors.map((mirror) => materializeOne({ installRoot, projectDir, mirror, deadline, allowLink })),
  ];
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > 16384) process.exit(1);
  });
  process.stdin.on('end', () => {
    try {
      process.stdout.write(JSON.stringify({ version: 1, results: runRequest(JSON.parse(input)) }));
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          version: 1,
          error: { message: error.message, code: error.code, errno: error.errno, syscall: error.syscall },
        }),
      );
      process.exitCode = 1;
    }
  });
}

module.exports = { runRequest, recoverInterrupted };
