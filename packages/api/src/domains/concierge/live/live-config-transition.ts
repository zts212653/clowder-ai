import type { ConciergeConfig } from '@cat-cafe/shared';
import type { IConciergeConfigStore } from '../ConciergeConfigStore.js';
import type { LiveCompanionSessions } from './LiveCompanionSessions.js';

export class ConfigurationReadFailedError extends Error {
  constructor() {
    super('Configuration read failed');
  }
}

/** A failed source read proves that this phase has issued no storage write. */
export async function readConfigurationForChange(
  store: IConciergeConfigStore,
  userId: string,
): Promise<ConciergeConfig> {
  try {
    return await store.get(userId);
  } catch {
    throw new ConfigurationReadFailedError();
  }
}

/** The same Host composition is consumed by routes and isolated contract tests. */
export function createLiveConfigChange(options: {
  store: IConciergeConfigStore;
  sessions: LiveCompanionSessions;
  ownerUserId: string;
  revokeMedia(): Promise<void>;
}) {
  return <T>(
    userId: string,
    save: () => Promise<T>,
    patch: Readonly<Record<string, unknown>>,
    onStopped?: () => void,
  ): Promise<T> =>
    options.sessions.withOwnerPreferenceChange(
      userId,
      save,
      async () => {
        const existing = await readConfigurationForChange(options.store, userId);
        if (!requiresLiveConfigStop(existing, patch)) return false;
        // Another user's settings cannot revoke the installing owner's body.
        if (userId === options.ownerUserId) await options.revokeMedia();
      },
      onStopped,
    );
}

/** Only a changed household-read grant ends this call; a saved plugin configuration restarts the companion. */
export function requiresLiveConfigStop(existing: ConciergeConfig, patch: Readonly<Record<string, unknown>>): boolean {
  return 'householdReadsAllowed' in patch && patch.householdReadsAllowed !== (existing.householdReadsAllowed !== false);
}
