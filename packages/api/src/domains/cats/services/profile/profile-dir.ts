/** @deprecated Use FileProfileRepository directly. Kept as a narrow canonical adapter. */
import { DEFAULT_PROFILE_USER_ID } from '@cat-cafe/shared/profile-contract';
import { FileProfileRepository } from './ProfileRepository.js';

export function resolveProfileDir(userId = DEFAULT_PROFILE_USER_ID, dataDir?: string): string {
  return new FileProfileRepository({ dataDir }).profileDir(userId);
}

/** @deprecated Read and write roots are identical under FileProfileRepository. */
export function resolveWritableProfileDir(userId = DEFAULT_PROFILE_USER_ID, dataDir?: string): string {
  return resolveProfileDir(userId, dataDir);
}
