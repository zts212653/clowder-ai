/**
 * CatRegistry — 运行时猫猫注册表
 *
 * 服务启动时从解析后的运行时猫配置注册所有猫。
 * 路由层和业务逻辑通过 registry 做运行时校验，
 * 替代旧的编译时 CatId union 校验。
 */

import type { CatConfig } from '../types/cat.js';
import type { CatId } from '../types/ids.js';
import { createCatId } from '../types/ids.js';

export interface CatRegistryEntry {
  readonly config: CatConfig;
}

export class CatRegistry {
  private entries = new Map<string, CatRegistryEntry>();
  private revision = 0;

  /**
   * Register a cat. Throws on duplicate ID.
   */
  register(catId: string, config: CatConfig): void {
    if (this.entries.has(catId)) {
      throw new Error(`Cat "${catId}" is already registered`);
    }
    this.entries.set(catId, { config });
    this.revision += 1;
  }

  has(catId: string): boolean {
    return this.entries.has(catId);
  }

  /**
   * Get entry — throws if not found. Use at boundary layers (routes, MCP callbacks).
   */
  getOrThrow(catId: string): CatRegistryEntry {
    const entry = this.entries.get(catId);
    if (!entry) {
      throw new Error(`Unknown cat ID: "${catId}". Registered: ${this.getAllIds().join(', ')}`);
    }
    return entry;
  }

  /**
   * Get entry — returns undefined if not found. Use where fallback is acceptable.
   */
  tryGet(catId: string): CatRegistryEntry | undefined {
    return this.entries.get(catId);
  }

  getAllIds(): CatId[] {
    return Array.from(this.entries.keys()).map((id) => createCatId(id));
  }

  getAllConfigs(): Record<string, CatConfig> {
    const result: Record<string, CatConfig> = {};
    for (const [id, entry] of this.entries) {
      result[id] = entry.config;
    }
    return result;
  }

  getRevision(): number {
    return this.revision;
  }

  /**
   * Non-empty tuple for z.enum() compat (if needed).
   * Throws if registry is empty.
   */
  getValidCatIds(): [string, ...string[]] {
    const ids = Array.from(this.entries.keys());
    if (ids.length === 0) {
      throw new Error('CatRegistry is empty — was it initialized before use?');
    }
    return ids as [string, ...string[]];
  }

  /** Clear all entries. For testing only. */
  reset(): void {
    this.entries.clear();
    this.revision += 1;
  }
}

/** Global singleton — populated at startup from the resolved runtime cat config */
export const catRegistry = new CatRegistry();

/**
 * Assert that a string is a registered cat ID. Throws if not.
 * Use at system boundaries (route handlers, MCP callbacks, external input).
 *
 * Unlike createCatId() which only checks syntax, this validates
 * against the runtime registry.
 */
export function assertKnownCatId(id: string): CatId {
  catRegistry.getOrThrow(id);
  return createCatId(id);
}
