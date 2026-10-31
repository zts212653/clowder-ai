import { createHash } from 'node:crypto';
import type { CharacterAssetSlot, VideoProjectAssetVersion } from '@cat-cafe/shared';

/** Sorted fields make operation and slot identities independent of DTO property order. */
export function canonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const canonDigest = (value: unknown) => `sha256:${createHash('sha256').update(canonJson(value)).digest('hex')}`;
export function indexedVersionRef(ownerUserId: string, version: VideoProjectAssetVersion): string {
  return `asset:${canonDigest({ ownerUserId, ...version.locator, sha256: version.sha256 })}`;
}
export const characterBindingRef = (ownerUserId: string, slot: CharacterAssetSlot) =>
  `binding:${canonDigest({ ownerUserId, slot })}`;
