import { randomUUID } from 'node:crypto';
import { closeSync, openSync, renameSync, writeFileSync } from 'node:fs';
import type { UserPreferences } from '@cat-cafe/shared';
import {
  type BackgroundGenerationPin,
  backgroundMetadataIsCurrent,
  collectBackgroundGenerations,
  pinBackgroundGeneration,
  removeBackgroundGeneration,
  userPreferencesPath,
} from './chat-background-file-generation.js';
import {
  type BackgroundMetadataWrite,
  hasBackgroundMetadataBindings,
  sealBackgroundMetadata,
  storedBackgroundMetadata,
} from './chat-background-metadata-lifecycle.js';
import { failAfterPreferenceCleanup, removePreferenceWriteFile } from './preference-write-cleanup.js';

/** Publish JSON and its already-created hard-link pin in the existing rename. */
export function writeUserPreferencesAtomic(
  root: string,
  previous: UserPreferences,
  next: UserPreferences,
  write?: BackgroundMetadataWrite,
): UserPreferences {
  const path = userPreferencesPath(root);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const trusted = backgroundMetadataIsCurrent(root, storedBackgroundMetadata(previous));
  let descriptor: number | undefined;
  let pin: BackgroundGenerationPin | undefined;
  let ownsTemp = false;
  let sealed = next;
  try {
    descriptor = openSync(tempPath, 'wx');
    ownsTemp = true;
    sealed = sealBackgroundMetadata(previous, next, trusted, undefined, write);
    if (hasBackgroundMetadataBindings(sealed)) {
      pin = pinBackgroundGeneration(root, tempPath);
      sealed = sealBackgroundMetadata(previous, sealed, trusted, pin.id, write);
    }
    writeFileSync(descriptor, `${JSON.stringify(sealed, null, 2)}\n`, 'utf-8');
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, path);
  } catch (error) {
    failAfterPreferenceCleanup(error, [
      {
        label: 'open preference descriptor',
        run: () => {
          if (descriptor !== undefined) closeSync(descriptor);
        },
      },
      {
        label: 'temporary preference file',
        run: () => {
          if (ownsTemp) removePreferenceWriteFile(tempPath);
        },
      },
      {
        label: 'unpublished generation pin',
        run: () => {
          if (pin) removeBackgroundGeneration(root, pin.id);
        },
      },
    ]);
  }
  collectBackgroundGenerations(root, pin);
  return sealed;
}
