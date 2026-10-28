import { basename, dirname, join } from 'node:path';
import { recoveryFile, recoveryPathExists, recoverySnapshot } from './preview-alpha-recovery-evidence.mjs';

export const EXPIRED_LEASE_SETTLEMENT = 'expired-named-alpha-lease-settlement';

function assertSourceArchives(directory, sources) {
  const entries = Object.entries(sources ?? {});
  if (entries.length > 176) throw new Error('expired lease journal exceeds its source bound');
  for (const [name, source] of entries) {
    if (!/^(record|completion|owner|lease|log|plist|command|history_\d+)$/.test(name))
      throw new Error('expired lease journal source is unknown');
    const archived = join(
      directory,
      name === 'log' ? 'preview.log' : name === 'plist' ? 'launchd.plist' : `${name}.json`,
    );
    if (recoverySnapshot(archived, { maxBytes: name === 'log' ? 16 * 1024 * 1024 : 32768 }).sha256 !== source.sha256)
      throw new Error('expired lease journal source changed');
  }
}

function assertDataArchives(directory, data) {
  if (!Array.isArray(data) || data.length > 256) throw new Error('expired lease data archive is invalid');
  let total = 0;
  for (const [index, saved] of data.entries()) {
    if (
      dirname(saved.savedPath) !== directory ||
      !new RegExp(`^data-${index}\\.(rdb|bin)$`).test(basename(saved.savedPath))
    )
      throw new Error('expired lease data archive coordinate changed');
    const file = recoverySnapshot(saved.savedPath, {
      maxBytes: Math.min(256 * 1024 * 1024, 512 * 1024 * 1024 - total),
    });
    total += file.bytes.length;
    if (file.sha256 !== saved.sha256 || file.bytes.length !== saved.size)
      throw new Error('expired lease archived data changed');
  }
}

/** A lease missing after interruption is usable only through this published archive. */
export function publishedExpiredLease(record) {
  const directory = `${record.completionPath}.settlement`;
  const intentPath = join(directory, 'intent.json');
  if (!recoveryPathExists(intentPath)) {
    if (recoveryPathExists(join(directory, 'lease.json')))
      throw new Error('expired lease archive has no publication proof');
    return null;
  }
  const intent = recoveryFile(intentPath).value;
  if (intent.kind !== EXPIRED_LEASE_SETTLEMENT) return null;
  const resultPath = join(directory, 'result.json');
  if (!recoveryPathExists(resultPath)) return { pending: true };
  const result = recoveryFile(resultPath).value;
  if (
    result.kind !== EXPIRED_LEASE_SETTLEMENT ||
    result.v !== 1 ||
    result.outcome?.leaseStatus !== 'retired' ||
    JSON.stringify(result.sources) !== JSON.stringify(intent.sources) ||
    JSON.stringify(result.data) !== JSON.stringify(intent.data)
  )
    throw new Error('expired lease retirement result is inconsistent');
  assertSourceArchives(directory, intent.sources);
  assertDataArchives(directory, result.data);
  const lease = recoveryFile(join(directory, 'lease.json'));
  if (lease.sha256 !== intent.sources?.lease?.sha256) throw new Error('expired lease archive changed');
  return { savedLease: { ...lease, path: intent.sources.lease.path } };
}
