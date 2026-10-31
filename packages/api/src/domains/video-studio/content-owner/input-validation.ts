import type { ContentActorV1 } from './types.js';

export function validateIdentity(value: string, field: string): void {
  if (value.length === 0 || value.length > 512 || value.trim() !== value || value.includes('\0'))
    throw new TypeError(`${field} is invalid`);
}
export function validateActor(actor: ContentActorV1): void {
  validateIdentity(actor.actorId, 'actorId');
  if (actor.kind !== 'human' && actor.kind !== 'cat') throw new TypeError('actor kind is invalid');
}
export function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError('expectedOwnerRevision must be a non-negative integer');
}
