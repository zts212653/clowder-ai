import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// ── Types ──

export type ConfigChangeSource = 'env' | 'config-store' | 'cat-config' | 'provider-profile' | 'secrets' | 'accounts';

export type ConfigChangeScope = 'key' | 'domain' | 'file';

export interface ConfigChangeEvent {
  source: ConfigChangeSource;
  scope: ConfigChangeScope;
  changedKeys: string[];
  changeSetId: string;
  timestamp: number;
}

// ── Helper ──

export function createChangeSetId(): string {
  return randomUUID();
}

// ── Bus ──

const CONFIG_CHANGE = 'config:change';

class ConfigEventBus extends EventEmitter {
  /** Emit a config change event (fire-and-forget). Listener exceptions are caught and logged, never propagated. */
  emitChange(event: ConfigChangeEvent): void {
    for (const listener of this.listeners(CONFIG_CHANGE)) {
      try {
        (listener as (e: ConfigChangeEvent) => void)(event);
      } catch (err) {
        console.error('[ConfigEventBus] listener threw during config:change — swallowed to protect caller', err);
      }
    }
  }

  /**
   * Emit and await: calls all listeners, then awaits any that return a Promise.
   * Fire-and-forget listeners (returning void) are not awaited.
   * Use this when the caller needs to wait for critical subscribers to finish.
   */
  async emitChangeAsync(event: ConfigChangeEvent): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const listener of this.listeners(CONFIG_CHANGE)) {
      try {
        const result = (listener as (e: ConfigChangeEvent) => void | Promise<void>)(event);
        if (result && typeof (result as Promise<void>).then === 'function') {
          promises.push(result as Promise<void>);
        }
      } catch (err) {
        console.error('[ConfigEventBus] listener threw during config:change — swallowed to protect caller', err);
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /** Subscribe to all config changes. Returns unsubscribe function. */
  onConfigChange(listener: (event: ConfigChangeEvent) => void): () => void {
    this.on(CONFIG_CHANGE, listener);
    return () => this.off(CONFIG_CHANGE, listener);
  }

  /**
   * Subscribe to changes affecting specific keys.
   * file-scope events (no key info) always fire (degraded mode).
   * Returns unsubscribe function.
   */
  onKeysChange(keys: string[], listener: (event: ConfigChangeEvent) => void): () => void {
    const keySet = new Set(keys);
    const filtered = (event: ConfigChangeEvent): void => {
      if (event.scope === 'file' || event.changedKeys.length === 0) {
        listener(event);
        return;
      }
      if (event.changedKeys.some((k) => keySet.has(k))) {
        listener(event);
      }
    };
    this.on(CONFIG_CHANGE, filtered);
    return () => this.off(CONFIG_CHANGE, filtered);
  }
}

export const configEventBus = new ConfigEventBus();
