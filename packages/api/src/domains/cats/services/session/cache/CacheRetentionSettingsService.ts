import type { CacheRetentionMemberStatus, CacheRetentionSessionStatus } from '@cat-cafe/shared';
import type { CacheRetentionSettingsStore } from './CacheRetentionSettingsStore.js';

export class CacheRetentionSettingsService {
  constructor(
    private readonly deps: {
      store: CacheRetentionSettingsStore;
      isSupported: (catId: string) => boolean;
      readSessions: (userId: string, catId: string) => Promise<CacheRetentionSessionStatus[]>;
      preferenceChanged: (userId: string, catId: string) => Promise<void>;
    },
  ) {}

  async get(userId: string, catId: string): Promise<CacheRetentionMemberStatus> {
    const preference = await this.deps.store.get(userId, catId);
    return {
      catId,
      supported: this.deps.isSupported(catId),
      enabled: preference.enabled,
      sessions: await this.deps.readSessions(userId, catId),
    };
  }

  async set(userId: string, catId: string, enabled: boolean): Promise<CacheRetentionMemberStatus> {
    if (enabled && !this.deps.isSupported(catId)) throw new Error('cache_retention_unsupported_member');
    await this.deps.store.set(userId, catId, enabled);
    await this.deps.preferenceChanged(userId, catId);
    return this.get(userId, catId);
  }
}
