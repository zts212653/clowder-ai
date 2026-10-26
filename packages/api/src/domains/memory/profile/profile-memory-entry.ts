import {
  CURRENT_CAPSULE_PROFILE_URI,
  CURRENT_CORPUS_PROFILE_URI,
  PROFILE_CAPSULE_RELATIVE_PATH,
  PROFILE_CORPUS_RELATIVE_PATH,
} from '@cat-cafe/shared/profile-contract';
import type { FileProfileRepository, ProfileFileSnapshot } from '../../cats/services/profile/ProfileRepository.js';
import type { StoredProfileMemoryEntry } from './ProfileMemoryLifecycleStore.js';

/** Both owner-wide files share one read projection; storage and mutation remain with Profile. */
export function sharedProfileMemoryEntry(
  repository: FileProfileRepository,
  ownerUserId: string,
  layer: 'capsule' | 'corpus',
  snapshot: ProfileFileSnapshot,
): StoredProfileMemoryEntry {
  const capsule = layer === 'capsule';
  return {
    ...snapshot,
    id: layer,
    type: 'profile',
    layer,
    relationshipKey: null,
    uri: capsule ? CURRENT_CAPSULE_PROFILE_URI : CURRENT_CORPUS_PROFILE_URI,
    title: capsule ? '开场简介' : '共同画像',
    status: 'active',
    profileDir: repository.profileDir(ownerUserId),
    targetPath: capsule ? PROFILE_CAPSULE_RELATIVE_PATH : PROFILE_CORPUS_RELATIVE_PATH,
  };
}
