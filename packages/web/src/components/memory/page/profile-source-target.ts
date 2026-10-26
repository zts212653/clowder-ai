import { memoryOwnerRevisionSchema } from '@cat-cafe/shared';
import { assertProfilePathSegment } from '@cat-cafe/shared/profile-contract';

export type ProfileSourceTarget = { status: 'ready'; id: string; revision: string } | { status: 'invalid' };

export function readProfileSourceTarget(
  params: Record<string, string | string[] | undefined>,
): ProfileSourceTarget | undefined {
  if (params.family !== 'profile') return undefined;
  const id = params.memoryId;
  const revision = params.revision;
  if (typeof id !== 'string' || typeof revision !== 'string' || !memoryOwnerRevisionSchema.safeParse(revision).success)
    return { status: 'invalid' };
  if (id !== 'corpus' && id !== 'capsule') {
    if (!id.startsWith('primer:')) return { status: 'invalid' };
    try {
      assertProfilePathSegment('relationshipKey', id.slice('primer:'.length));
    } catch {
      return { status: 'invalid' };
    }
  }
  return { status: 'ready', id, revision };
}
