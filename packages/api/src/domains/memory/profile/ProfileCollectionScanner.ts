import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  LEGACY_PROFILE_CAPSULE_RELATIVE_PATH,
  PROFILE_CAPSULE_RELATIVE_PATH,
  PROFILE_MEMORY_TOMBSTONE_PREFIX,
  profileCapsuleReadRelativePath,
} from '@cat-cafe/shared/profile-contract';
import { FlatScanner } from '../FlatScanner.js';
import type { ScannedEvidence } from '../interfaces.js';

/** The private index projects current Profile files using the same compatibility rule as opening reads. */
export class ProfileCollectionScanner extends FlatScanner {
  protected override parseFile(filePath: string, root: string): ScannedEvidence | null {
    const path = relative(root, filePath).replaceAll('\\', '/');
    if (path === PROFILE_CAPSULE_RELATIVE_PATH || path === LEGACY_PROFILE_CAPSULE_RELATIVE_PATH) {
      const effective = profileCapsuleReadRelativePath((candidate) => existsSync(join(root, candidate)));
      if (path !== effective) return null;
    }
    const evidence = super.parseFile(filePath, root);
    return evidence?.rawContent?.startsWith(PROFILE_MEMORY_TOMBSTONE_PREFIX) ? null : evidence;
  }
}
