import type { LockVersion } from '@cat-cafe/shared';

interface LockVersionInput {
  source: LockVersion['source'];
  version: string;
  channel?: string;
  installedBy: string;
}

export function buildLockVersion(input: LockVersionInput): LockVersion {
  if (!input.version) {
    throw new Error('version is required');
  }
  return {
    source: input.source,
    version: input.version,
    ...(input.channel ? { channel: input.channel } : {}),
    installedAt: new Date().toISOString(),
    installedBy: input.installedBy,
  };
}
