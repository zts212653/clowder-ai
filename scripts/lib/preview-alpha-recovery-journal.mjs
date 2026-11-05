import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  recoveryFile,
  recoveryPathExists,
  syncRecoveryDirectory,
  writeRecoveryBytes,
  writeRecoveryFile,
} from './preview-alpha-recovery-evidence.mjs';

export function recoveryJournalRoot(record) {
  const root = `${record.completionPath}.recovery`;
  if (!recoveryPathExists(root)) return root;
  if (realpathSync(root) !== root) throw new Error('preview recovery journal is linked');
  return root;
}

export function priorRecovery(root) {
  if (!recoveryPathExists(root)) return null;
  const names = readdirSync(root);
  if (names.length > 32) throw new Error('preview recovery journal needs owner inspection');
  let completed;
  for (const name of names) {
    if (!/^[a-f0-9-]{36}$/.test(name) || realpathSync(join(root, name)) !== join(root, name))
      throw new Error('preview recovery attempt is unproven');
    const directory = join(root, name);
    if (recoveryPathExists(join(directory, 'result.json'))) {
      const result = recoveryFile(join(directory, 'result.json')).value;
      if (completed || result.kind !== 'named-alpha-cleanup-recovery' || result.shutdownExitCode !== 0)
        throw new Error('preview recovery result is inconsistent');
      const lease = recoveryFile(join(directory, 'lease.json'));
      completed = { directory, result, savedLease: { ...lease, path: result.sources.lease.path } };
    } else if (recoveryPathExists(join(directory, 'shutdown-intent.json'))) {
      throw new Error('previous shutdown outcome is unproven; refusing to replay a Redis command');
    }
  }
  return completed;
}

export function beginRecovery(root, evidence) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw new Error('preview recovery journal is linked');
  syncRecoveryDirectory(dirname(root));
  const directory = join(root, randomUUID());
  mkdirSync(directory, { mode: 0o700 });
  syncRecoveryDirectory(root);
  const sources = {};
  for (const [name, file] of Object.entries(evidence.sources)) {
    writeRecoveryBytes(join(directory, `${name}.json`), file.bytes);
    sources[name] = { path: file.path, sha256: file.sha256 };
  }
  writeRecoveryFile(join(directory, 'attempt.json'), {
    v: 1,
    kind: 'named-alpha-cleanup-recovery',
    startedAt: new Date().toISOString(),
    sources,
    redis: evidence.proof,
  });
  return { directory, sources };
}
