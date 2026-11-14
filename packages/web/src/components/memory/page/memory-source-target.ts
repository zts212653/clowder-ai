import { memoryOwnerRevisionSchema } from '@cat-cafe/shared';
export type MemorySourceFamily = 'taste' | 'person' | 'event';
export type MemorySourceTarget =
  | { status: 'ready'; family: MemorySourceFamily; id: string; revision?: string }
  | { status: 'invalid' };
const identifiers = {
  taste: /^taste-[a-f0-9]{24}$/,
  person: /^person_[A-Za-z0-9_-]+$/,
  event: /^[A-Za-z0-9_-]{1,200}$/,
};
export function readMemorySourceTarget(
  params: Record<string, string | string[] | undefined>,
): MemorySourceTarget | undefined {
  const family = params.family;
  if (family === undefined || family === 'profile') return undefined;
  if (family !== 'taste' && family !== 'person' && family !== 'event') return { status: 'invalid' };
  const id = params.memoryId;
  const revision = params.revision;
  if (
    typeof id !== 'string' ||
    !identifiers[family].test(id) ||
    (revision !== undefined && (typeof revision !== 'string' || !memoryOwnerRevisionSchema.safeParse(revision).success))
  )
    return { status: 'invalid' };
  return { status: 'ready', family, id, revision };
}
