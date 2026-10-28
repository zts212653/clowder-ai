import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasRdbEnvelope } from '../redis-backup-retention.mjs';
import { namedAlphaRedisRegistryDir } from './alpha-redis-leases.mjs';
import {
  readAlphaCompletionEvidence,
  recoveryFile,
  recoveryPathExists,
  recoverySnapshot,
  sameRecoveryFile,
  syncRecoveryDirectory,
  writeRecoveryBytes,
  writeRecoveryFile,
} from './preview-alpha-recovery-evidence.mjs';
import {
  assertRecoveryLaunchd,
  assertRecoveryQuiescence,
  recoveryListeners,
} from './preview-alpha-recovery-observation.mjs';

import { publishRegistrationResult } from './preview-registration-receipts.mjs';

export {
  clearPreviewSettlement,
  publishRegistrationResult,
  readPreviewSettlement,
} from './preview-registration-receipts.mjs';

const journalPath = (record) => `${record.completionPath}.settlement`;

function assertDirectory(path) {
  if (realpathSync(path) !== path) throw new Error('settlement directory is linked');
}

export function portLeases(coordinates, deps) {
  const directory = deps.registryDir ?? namedAlphaRedisRegistryDir();
  // A missing/unreadable registry is not evidence of an empty registry.
  if (lstatSync(directory).isSymbolicLink()) throw new Error('named Alpha lease registry is linked');
  const physical = realpathSync(directory);
  const names = readdirSync(physical);
  if (names.length > 4096) throw new Error('settlement lease observation exceeds its bound');
  return names.filter((name) => name.startsWith(`redis-${coordinates.ports.redis}-`));
}

function assertStopped(config, record, evidence, deps) {
  assertRecoveryQuiescence(record, evidence.owner, evidence.coordinates, deps);
  assertRecoveryLaunchd(config, record, deps.readJob);
  if ((deps.readListeners ?? recoveryListeners)(evidence.coordinates.ports.redis).length)
    throw new Error('named Alpha Redis port is live; registration cannot be settled');
  if (portLeases(evidence.coordinates, deps).length)
    throw new Error('named Alpha producer lease appeared during settlement');
}

export function snapshotData(evidence) {
  const { alphaRoot, ports } = evidence.coordinates;
  const files = [];
  const dataDirectory = join(alphaRoot, '.cat-cafe/redis');
  const backupDirectory = join(alphaRoot, '.cat-cafe/redis-backups');
  const dump = join(dataDirectory, 'dump.rdb');
  if (recoveryPathExists(dataDirectory)) {
    assertDirectory(dataDirectory);
    if (recoveryPathExists(dump)) files.push(dump);
  }
  if (recoveryPathExists(backupDirectory)) {
    assertDirectory(backupDirectory);
    for (const name of readdirSync(backupDirectory).sort())
      if (name.startsWith(`worktree-${ports.redis}-pre-`) && name.endsWith('.rdb'))
        files.push(join(backupDirectory, name));
  }
  if (files.length > 32) throw new Error('settlement data archive needs owner inspection');
  let total = 0;
  return files.map((path) => {
    const snapshot = recoverySnapshot(path, { maxBytes: 256 * 1024 * 1024 });
    total += snapshot.bytes.length;
    if (total > 512 * 1024 * 1024 || !hasRdbEnvelope(path))
      throw new Error('settlement RDB evidence is incomplete or too large');
    return snapshot;
  });
}

function preserve(path, snapshot) {
  if (recoveryPathExists(path)) {
    if (recoverySnapshot(path, snapshot).sha256 !== snapshot.sha256)
      throw new Error('settlement journal differs from original evidence');
  } else writeRecoveryBytes(path, snapshot.bytes);
}

export function assertRegistrationSources(evidence, snapshots) {
  for (const snapshot of [...Object.values(evidence.sources), ...snapshots]) sameRecoveryFile(snapshot);
}

export function preserveRegistrationJournal(
  record,
  evidence,
  snapshots,
  kind = 'named-alpha-registration-settlement',
  details = {},
) {
  const directory = journalPath(record);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertDirectory(directory);
  syncRecoveryDirectory(dirname(directory));
  const sources = {};
  for (const [name, snapshot] of Object.entries(evidence.sources)) {
    preserve(
      join(directory, name === 'log' ? 'preview.log' : name === 'plist' ? 'launchd.plist' : `${name}.json`),
      snapshot,
    );
    sources[name] = { path: snapshot.path, sha256: snapshot.sha256 };
  }
  const data = snapshots.map((snapshot, index) => {
    const savedPath = join(directory, `data-${index}.rdb`);
    preserve(savedPath, snapshot);
    return { path: snapshot.path, savedPath, sha256: snapshot.sha256, size: snapshot.bytes.length };
  });
  const intent = { v: 1, kind, sources, data, ...details };
  const path = join(directory, 'intent.json');
  if (recoveryPathExists(path)) {
    if (JSON.stringify(recoveryFile(path).value) !== JSON.stringify(intent))
      throw new Error('settlement intent belongs to changed source or data');
  } else writeRecoveryFile(path, intent);
  return { directory, intent };
}

/** No Redis protocol: retire only an absent instance, preserving the unknown save outcome. */
export async function settleStoppedNamedAlphaRegistration(config, record, deps = {}) {
  const evidence = readAlphaCompletionEvidence(config, record);
  if (portLeases(evidence.coordinates, deps).length) return null;
  assertStopped(config, record, evidence, deps);
  if (record.logPath) {
    if (record.logPath !== (config.logPath ?? join(config.stateDir, `${config.id}.log`)))
      throw new Error('settlement log coordinate changed');
    evidence.sources.log = recoverySnapshot(record.logPath, { maxBytes: 16 * 1024 * 1024 });
  }
  if (record.origin === 'launchd') evidence.sources.plist = recoverySnapshot(config.plistPath);
  const snapshots = snapshotData(evidence);
  const journal = preserveRegistrationJournal(record, evidence, snapshots);
  assertRegistrationSources(evidence, snapshots);
  assertStopped(config, record, evidence, deps);
  const summary = publishRegistrationResult(config, record, evidence, journal);
  await deps.afterSettlementJournal?.();
  assertRegistrationSources(evidence, snapshots);
  assertStopped(config, record, evidence, deps);
  return {
    record: evidence.sources.record,
    summary,
    assertReadyToRelease: () => {
      assertRegistrationSources(evidence, snapshots);
      assertStopped(config, record, evidence, deps);
    },
  };
}
