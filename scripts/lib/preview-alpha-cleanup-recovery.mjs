import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasRdbEnvelope } from '../redis-backup-retention.mjs';
import { verifyNamedAlphaRedisIdentity } from './alpha-redis-process.mjs';
import {
  readFailedAlphaEvidence,
  recoveryHash,
  recoveryPathExists,
  sameRecoveryFile,
  syncRecoveryDirectory,
  writeRecoveryBytes,
  writeRecoveryFile,
} from './preview-alpha-recovery-evidence.mjs';
import { beginRecovery, priorRecovery, recoveryJournalRoot } from './preview-alpha-recovery-journal.mjs';
import {
  assertRecoveryLaunchd,
  assertRecoveryQuiescence,
  recoveryListeners,
} from './preview-alpha-recovery-observation.mjs';
import { isProcessRunning } from './process-tree.mjs';

function rdbEvidence(path) {
  const before = lstatSync(path);
  if (
    realpathSync(path) !== path ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > 256 * 1024 * 1024 ||
    !hasRdbEnvelope(path)
  )
    throw new Error('recovery RDB snapshot is incomplete, linked or too large');
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== bytes.length)
    throw new Error('recovery RDB changed during read');
  return { path, bytes, sha256: recoveryHash(bytes), size: bytes.length };
}

function assertSources(evidence, leaseMissing = false) {
  for (const [name, source] of Object.entries(evidence.sources))
    sameRecoveryFile(source, { missing: leaseMissing && name === 'lease' });
}

function assertResourceExit(evidence, deps) {
  assertRecoveryQuiescence(evidence.sources.record.value, evidence.owner, evidence.coordinates, deps);
  if (
    (deps.isRunning ?? isProcessRunning)(evidence.proof.pid) !== false ||
    (deps.readListeners ?? recoveryListeners)(evidence.proof.port).length
  )
    throw new Error('recovered Redis exit is not proven');
}

function checkCompleted(prior, evidence, deps) {
  for (const [name, source] of Object.entries(evidence.sources)) {
    const expected = prior.result.sources?.[name];
    if (expected?.path !== source.path || expected?.sha256 !== source.sha256)
      throw new Error('recovery result belongs to another lifecycle');
  }
  if (prior.result.savedRdb?.path !== join(evidence.proof.dataDirectory, 'dump.rdb'))
    throw new Error('recovery saved RDB coordinate changed');
  const saved = rdbEvidence(prior.result.savedRdb.path);
  if (saved.sha256 !== prior.result.savedRdb.sha256 || saved.size !== prior.result.savedRdb.size)
    throw new Error('recovery saved RDB changed');
  assertResourceExit(evidence, deps);
  assertSources(evidence, true);
}

function recoveryQueries(config, record, evidence, deps) {
  const run = deps.run ?? execFileSync;
  const verify = () => {
    assertSources(evidence);
    assertRecoveryQuiescence(record, evidence.owner, evidence.coordinates, deps);
    assertRecoveryLaunchd(config, record, deps.readJob);
    verifyNamedAlphaRedisIdentity(JSON.stringify(evidence.coordinates), evidence.proof, deps);
  };
  return (...command) => {
    verify();
    return run('redis-cli', ['-h', '127.0.0.1', '-p', String(evidence.proof.port), '-e', '--raw', ...command], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  };
}

function preserveRecoveryData(evidence, query) {
  const dataDirectory = query('config', 'get', 'dir').split('\n');
  const filename = query('config', 'get', 'dbfilename').split('\n');
  if (
    dataDirectory[0] !== 'dir' ||
    dataDirectory.length !== 2 ||
    dataDirectory[1] !== evidence.proof.dataDirectory ||
    filename.join('\n') !== 'dbfilename\ndump.rdb'
  )
    throw new Error('Redis persistence coordinate changed');
  const dump = join(evidence.proof.dataDirectory, 'dump.rdb');
  const before = recoveryPathExists(dump) ? rdbEvidence(dump) : null;
  const size = query('dbsize');
  if (!/^\d+$/.test(size) || (before?.size >= 1024 && BigInt(size) === 0n))
    throw new Error('preserving unverified startup snapshot or anomalous empty database; no saving cleanup');
  if (!before) return { dump };
  const backups = join(evidence.coordinates.alphaRoot, '.cat-cafe/redis-backups');
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  if (realpathSync(backups) !== backups) throw new Error('recovery backup directory is linked');
  syncRecoveryDirectory(dirname(backups));
  const backup = {
    path: join(backups, `worktree-${evidence.proof.port}-pre-recovery-${randomUUID()}.rdb`),
    sha256: before.sha256,
    size: before.size,
  };
  writeRecoveryBytes(backup.path, before.bytes);
  if (rdbEvidence(dump).sha256 !== before.sha256) throw new Error('Redis snapshot changed before recovery SAVE');
  return { dump, backup };
}

async function saveRecovery(config, record, evidence, root, deps) {
  const attempt = beginRecovery(root, evidence);
  const query = recoveryQueries(config, record, evidence, deps);
  const { dump, backup } = preserveRecoveryData(evidence, query);
  // Intent precedes the single mutating command. An interrupted command is
  // never replayed, even if the listener subsequently vanishes.
  writeRecoveryFile(join(attempt.directory, 'shutdown-intent.json'), {
    requestedAt: new Date().toISOString(),
    sources: attempt.sources,
    redis: evidence.proof,
    backup,
  });
  query('shutdown', 'save');
  const deadline = Date.now() + 5000;
  while ((deps.isRunning ?? isProcessRunning)(evidence.proof.pid) === true && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assertResourceExit(evidence, deps);
  const saved = rdbEvidence(dump);
  assertSources(evidence);
  writeRecoveryFile(join(attempt.directory, 'result.json'), {
    v: 1,
    kind: 'named-alpha-cleanup-recovery',
    shutdownExitCode: 0,
    completedAt: new Date().toISOString(),
    sources: attempt.sources,
    backup,
    savedRdb: { path: saved.path, sha256: saved.sha256, size: saved.size },
  });
}

/** Runs only under the same start/stop mutation lock, never with a synthetic live owner. */
export async function recoverFailedNamedAlphaCleanup(config, record, deps = {}) {
  const root = recoveryJournalRoot(record);
  const prior = priorRecovery(root);
  const evidence = readFailedAlphaEvidence(config, record, { ...deps, savedLease: prior?.savedLease });
  assertRecoveryQuiescence(record, evidence.owner, evidence.coordinates, deps);
  assertRecoveryLaunchd(config, record, deps.readJob);
  if (prior) checkCompleted(prior, evidence, deps);
  else await saveRecovery(config, record, evidence, root, deps);
  assertSources(evidence, Boolean(prior));
  try {
    (deps.removeLease ?? rmSync)(evidence.sources.lease.path);
  } catch (error) {
    if (!prior || error.code !== 'ENOENT') throw error;
  }
  return evidence.sources.record;
}
