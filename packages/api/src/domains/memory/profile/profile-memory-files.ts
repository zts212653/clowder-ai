import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileMemoryOwnerAction } from '@cat-cafe/shared';
import { isProfileMemoryTombstoneContent } from '../../cats/services/profile/ProfileRepository.js';

export function profileMemoryTombstoneContent(
  ownerUserId: string,
  memoryId: string,
  command: Extract<ProfileMemoryOwnerAction, { action: 'hard_forget' }>,
): string {
  return `${JSON.stringify({
    catCafeProfileTombstone: 1,
    ownerUserId,
    memoryId,
    requestId: command.requestId,
    expectedRevision: command.expectedRevision,
  })}\n`;
}

export function removeMatchingProfileTombstone(path: string, requestId: string, aliases: string[] = []): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  if (!isProfileMemoryTombstoneContent(content)) return;
  let marker: { requestId?: unknown };
  try {
    marker = JSON.parse(content) as { requestId?: unknown };
  } catch {
    // A malformed/non-lifecycle file must never be removed by cleanup.
    return;
  }
  if (marker.requestId === requestId) {
    // Keep the canonical tombstone until every alias is gone; I/O failure remains retryable.
    for (const alias of aliases) rmSync(alias, { force: true });
    rmSync(path, { force: true });
  }
}

export function purgeTargetProvenance(profileDir: string, targetPath: string): void {
  const provenanceDir = join(profileDir, 'provenance');
  if (!existsSync(provenanceDir)) return;
  for (const entry of readdirSync(provenanceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(provenanceDir, entry.name);
    const content = readFileSync(path, 'utf8');
    if (content.split('\n').some((line) => line === `- target: ${targetPath}`)) rmSync(path, { force: true });
  }
}
