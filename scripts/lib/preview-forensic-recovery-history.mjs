import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryFile, recoveryPathExists } from './preview-alpha-recovery-evidence.mjs';
import { priorRecovery, recoveryJournalRoot } from './preview-alpha-recovery-journal.mjs';

/** Only pre-protocol forensic attempts qualify; completed saving recovery keeps its own consumer. */
export function readForensicRecoveryHistory(record, evidence) {
  const root = recoveryJournalRoot(record);
  if (priorRecovery(root)) return null;
  if (!recoveryPathExists(root)) return { files: [], fingerprint: 'absent' };
  const files = [],
    attempts = readdirSync(root).sort();
  const keys = ['record', 'completion', 'owner', 'lease'];
  const expected = Object.fromEntries(
    keys.map((k) => [k, { path: evidence.sources[k].path, sha256: evidence.sources[k].sha256 }]),
  );
  for (const name of attempts) {
    const directory = join(root, name);
    if (realpathSync(directory) !== directory) throw new Error('forensic recovery directory is linked');
    const names = readdirSync(directory).sort();
    const required = ['attempt.json', ...keys.map((k) => `${k}.json`)].sort();
    if (JSON.stringify(names) !== JSON.stringify(required)) throw new Error('forensic recovery history is incomplete');
    const attempt = recoveryFile(join(directory, 'attempt.json'));
    const a = attempt.value;
    if (
      a.v !== 1 ||
      a.kind !== 'named-alpha-cleanup-recovery' ||
      !Number.isFinite(Date.parse(a.startedAt)) ||
      Date.parse(a.startedAt) < Date.parse(evidence.sources.completion.value.completedAt) ||
      JSON.stringify(a.sources) !== JSON.stringify(expected) ||
      JSON.stringify(a.redis) !== JSON.stringify(evidence.proof)
    )
      throw new Error('forensic recovery attempt belongs to another lifecycle');
    files.push(attempt);
    for (const key of keys) {
      const saved = recoveryFile(join(directory, `${key}.json`));
      if (saved.sha256 !== evidence.sources[key].sha256) throw new Error('forensic recovery source changed');
      files.push(saved);
    }
  }
  return { files, fingerprint: JSON.stringify(files.map((s) => [s.path, s.sha256])) };
}
