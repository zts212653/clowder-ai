import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFailedAlphaEvidence } from './preview-alpha-recovery-evidence.mjs';
import { beginRecovery, recoveryJournalRoot } from './preview-alpha-recovery-journal.mjs';
import { failedAlphaFixture } from './preview-alpha-recovery-test-fixture.mjs';

export function expiredLeaseFixture(t) {
  const f = failedAlphaFixture(t);
  f.recovery.isRunning = () => false;
  f.recovery.readListeners = () => [];
  f.recovery.run = () => {
    throw new Error('metadata retirement must not send protocol');
  };
  return f;
}

export function forensicAttempt(f) {
  return beginRecovery(recoveryJournalRoot(f.record), readFailedAlphaEvidence(f.config, f.record, f.recovery));
}

export const retainedBytes = (f) =>
  [f.config.recordPath, f.record.completionPath, `${f.record.completionPath}.owner.json`, f.leaseFile, f.dumpFile].map(
    (path) => readFileSync(path),
  );

export function addAofSet(f) {
  const directory = join(f.proof.dataDirectory, 'appendonlydir');
  const backups = join(f.alphaRoot, '.cat-cafe/redis-backups');
  mkdirSync(directory);
  mkdirSync(backups);
  const files = [
    [
      join(directory, 'appendonly.aof.manifest'),
      'file appendonly.aof.1.base.rdb seq 1 type b\nfile appendonly.aof.1.incr.aof seq 1 type i\n',
    ],
    [join(directory, 'appendonly.aof.1.base.rdb'), readFileSync(f.dumpFile)],
    [join(directory, 'appendonly.aof.1.incr.aof'), '*1\r\n$4\r\nPING\r\n'],
    [join(backups, `worktree-${f.proof.port}-pre-stop-original.rdb`), readFileSync(f.dumpFile)],
  ];
  for (const [path, bytes] of files) writeFileSync(path, bytes);
  return files.map(([path]) => path);
}
