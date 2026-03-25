/**
 * F134 Phase D: Connector Permission Store
 * Manages group whitelist + admin list + command restriction settings.
 *
 * Two implementations:
 * - MemoryConnectorPermissionStore: for tests and dev fallback
 * - RedisConnectorPermissionStore: for production (persists across restarts)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';

export interface GroupEntry {
  readonly externalChatId: string;
  readonly label?: string;
  readonly addedAt: number;
}

export interface PermissionConfig {
  readonly whitelistEnabled: boolean;
  readonly commandAdminOnly: boolean;
  readonly adminOpenIds: readonly string[];
  readonly allowedGroups: readonly GroupEntry[];
}

export interface IConnectorPermissionStore {
  /** Check if a group chat is allowed (returns true if whitelist disabled OR group in whitelist). */
  isGroupAllowed(connectorId: string, externalChatId: string): Promise<boolean>;
  allowGroup(connectorId: string, externalChatId: string, label?: string): Promise<void>;
  denyGroup(connectorId: string, externalChatId: string): Promise<boolean>;
  listAllowedGroups(connectorId: string): Promise<readonly GroupEntry[]>;

  isWhitelistEnabled(connectorId: string): Promise<boolean>;
  setWhitelistEnabled(connectorId: string, enabled: boolean): Promise<void>;

  isAdmin(connectorId: string, senderOpenId: string): Promise<boolean>;
  getAdminOpenIds(connectorId: string): Promise<readonly string[]>;
  setAdminOpenIds(connectorId: string, openIds: string[]): Promise<void>;

  isCommandAdminOnly(connectorId: string): Promise<boolean>;
  setCommandAdminOnly(connectorId: string, enabled: boolean): Promise<void>;

  /** True if admin config has ever been explicitly written (even if empty). */
  hasAdminConfig(connectorId: string): Promise<boolean>;
  /** Full snapshot for API/UI consumption. */
  getConfig(connectorId: string): Promise<PermissionConfig>;
}

export class MemoryConnectorPermissionStore implements IConnectorPermissionStore {
  private whitelistEnabled = new Map<string, boolean>();
  private commandAdminOnly = new Map<string, boolean>();
  private adminOpenIds = new Map<string, string[]>();
  private allowedGroups = new Map<string, Map<string, GroupEntry>>();

  async isGroupAllowed(connectorId: string, externalChatId: string): Promise<boolean> {
    if (!this.whitelistEnabled.get(connectorId)) return true;
    const groups = this.allowedGroups.get(connectorId);
    return groups?.has(externalChatId) ?? false;
  }

  async allowGroup(connectorId: string, externalChatId: string, label?: string): Promise<void> {
    let groups = this.allowedGroups.get(connectorId);
    if (!groups) {
      groups = new Map();
      this.allowedGroups.set(connectorId, groups);
    }
    groups.set(externalChatId, { externalChatId, label, addedAt: Date.now() });
  }

  async denyGroup(connectorId: string, externalChatId: string): Promise<boolean> {
    const groups = this.allowedGroups.get(connectorId);
    return groups?.delete(externalChatId) ?? false;
  }

  async listAllowedGroups(connectorId: string): Promise<readonly GroupEntry[]> {
    const groups = this.allowedGroups.get(connectorId);
    return groups ? [...groups.values()] : [];
  }

  async isWhitelistEnabled(connectorId: string): Promise<boolean> {
    return this.whitelistEnabled.get(connectorId) ?? false;
  }

  async setWhitelistEnabled(connectorId: string, enabled: boolean): Promise<void> {
    this.whitelistEnabled.set(connectorId, enabled);
  }

  async isAdmin(connectorId: string, senderOpenId: string): Promise<boolean> {
    const admins = this.adminOpenIds.get(connectorId);
    return admins?.includes(senderOpenId) ?? false;
  }

  async getAdminOpenIds(connectorId: string): Promise<readonly string[]> {
    return this.adminOpenIds.get(connectorId) ?? [];
  }

  async setAdminOpenIds(connectorId: string, openIds: string[]): Promise<void> {
    this.adminOpenIds.set(connectorId, [...openIds]);
  }

  async hasAdminConfig(connectorId: string): Promise<boolean> {
    return this.adminOpenIds.has(connectorId);
  }

  async isCommandAdminOnly(connectorId: string): Promise<boolean> {
    return this.commandAdminOnly.get(connectorId) ?? false;
  }

  async setCommandAdminOnly(connectorId: string, enabled: boolean): Promise<void> {
    this.commandAdminOnly.set(connectorId, enabled);
  }

  async getConfig(connectorId: string): Promise<PermissionConfig> {
    return {
      whitelistEnabled: this.whitelistEnabled.get(connectorId) ?? false,
      commandAdminOnly: this.commandAdminOnly.get(connectorId) ?? false,
      adminOpenIds: this.adminOpenIds.get(connectorId) ?? [],
      allowedGroups: await this.listAllowedGroups(connectorId),
    };
  }
}

/**
 * Redis-backed permission store. Survives restarts.
 *
 * Keys (all prefixed by ioredis keyPrefix if configured):
 *   Hash  connector-perm:{connectorId}         → { whitelistEnabled, commandAdminOnly, adminOpenIds (JSON) }
 *   Hash  connector-perm-groups:{connectorId}  → { externalChatId → JSON({ label, addedAt }) }
 */
export class RedisConnectorPermissionStore implements IConnectorPermissionStore {
  constructor(private readonly redis: RedisClient) {}

  private configKey(cid: string): string {
    return `connector-perm:${cid}`;
  }
  private groupsKey(cid: string): string {
    return `connector-perm-groups:${cid}`;
  }

  async isGroupAllowed(connectorId: string, externalChatId: string): Promise<boolean> {
    const enabled = await this.redis.hget(this.configKey(connectorId), 'whitelistEnabled');
    if (enabled !== 'true') return true;
    const exists = await this.redis.hexists(this.groupsKey(connectorId), externalChatId);
    return exists === 1;
  }

  async allowGroup(connectorId: string, externalChatId: string, label?: string): Promise<void> {
    await this.redis.hset(this.groupsKey(connectorId), externalChatId, JSON.stringify({ label, addedAt: Date.now() }));
  }

  async denyGroup(connectorId: string, externalChatId: string): Promise<boolean> {
    const removed = await this.redis.hdel(this.groupsKey(connectorId), externalChatId);
    return removed > 0;
  }

  async listAllowedGroups(connectorId: string): Promise<readonly GroupEntry[]> {
    const all = await this.redis.hgetall(this.groupsKey(connectorId));
    return Object.entries(all).map(([chatId, json]) => {
      const parsed = JSON.parse(json) as { label?: string; addedAt?: number };
      return { externalChatId: chatId, label: parsed.label, addedAt: parsed.addedAt ?? 0 };
    });
  }

  async isWhitelistEnabled(connectorId: string): Promise<boolean> {
    return (await this.redis.hget(this.configKey(connectorId), 'whitelistEnabled')) === 'true';
  }

  async setWhitelistEnabled(connectorId: string, enabled: boolean): Promise<void> {
    await this.redis.hset(this.configKey(connectorId), 'whitelistEnabled', String(enabled));
  }

  async isAdmin(connectorId: string, senderOpenId: string): Promise<boolean> {
    const raw = await this.redis.hget(this.configKey(connectorId), 'adminOpenIds');
    if (!raw) return false;
    const ids = JSON.parse(raw) as string[];
    return ids.includes(senderOpenId);
  }

  async getAdminOpenIds(connectorId: string): Promise<readonly string[]> {
    const raw = await this.redis.hget(this.configKey(connectorId), 'adminOpenIds');
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  async setAdminOpenIds(connectorId: string, openIds: string[]): Promise<void> {
    await this.redis.hset(this.configKey(connectorId), 'adminOpenIds', JSON.stringify(openIds));
  }

  async hasAdminConfig(connectorId: string): Promise<boolean> {
    return (await this.redis.hexists(this.configKey(connectorId), 'adminOpenIds')) === 1;
  }

  async isCommandAdminOnly(connectorId: string): Promise<boolean> {
    return (await this.redis.hget(this.configKey(connectorId), 'commandAdminOnly')) === 'true';
  }

  async setCommandAdminOnly(connectorId: string, enabled: boolean): Promise<void> {
    await this.redis.hset(this.configKey(connectorId), 'commandAdminOnly', String(enabled));
  }

  async getConfig(connectorId: string): Promise<PermissionConfig> {
    return {
      whitelistEnabled: await this.isWhitelistEnabled(connectorId),
      commandAdminOnly: await this.isCommandAdminOnly(connectorId),
      adminOpenIds: await this.getAdminOpenIds(connectorId),
      allowedGroups: await this.listAllowedGroups(connectorId),
    };
  }
}
