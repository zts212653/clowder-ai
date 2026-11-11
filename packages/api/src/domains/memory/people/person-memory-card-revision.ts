import { createHash } from 'node:crypto';
import type { RelationshipCard } from '@cat-cafe/shared';
export function personMemoryCardRevision(card: RelationshipCard): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(card)).digest('hex')}`;
}
