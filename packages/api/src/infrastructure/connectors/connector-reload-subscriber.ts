/**
 * Connector Reload Subscriber — F136 Phase 2
 *
 * Subscribes to configEventBus, filters for connector-related key changes,
 * debounces rapid updates, and triggers gateway restart.
 */

import { type ConfigChangeEvent, configEventBus } from '../../config/config-event-bus.js';
import { CONNECTOR_SECRETS_ALLOWLIST } from '../../config/connector-secrets-allowlist.js';

export interface ConnectorReloadSubscriberOpts {
  onRestart: () => Promise<void>;
  debounceMs?: number;
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
}

export interface ConnectorReloadSubscriberHandle {
  unsubscribe(): void;
}

function isConnectorRelated(event: ConfigChangeEvent): boolean {
  // File-scope = can't determine which keys changed, restart conservatively
  if (event.scope === 'file') return true;
  // Empty changedKeys with file scope handled above; otherwise not relevant
  if (event.changedKeys.length === 0) return false;
  return event.changedKeys.some((k) => CONNECTOR_SECRETS_ALLOWLIST.has(k));
}

export function createConnectorReloadSubscriber(opts: ConnectorReloadSubscriberOpts): ConnectorReloadSubscriberHandle {
  const debounceMs = opts.debounceMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const listener = (event: ConfigChangeEvent): void => {
    if (!isConnectorRelated(event)) return;

    // Debounce: clear previous timer, schedule new restart
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      opts.log.info('[ConnectorReloadSubscriber] Connector config changed, restarting gateway...');
      try {
        await opts.onRestart();
        opts.log.info('[ConnectorReloadSubscriber] Gateway restart complete');
      } catch (err) {
        opts.log.warn('[ConnectorReloadSubscriber] Gateway restart failed:', err);
      }
    }, debounceMs);
  };

  const unsub = configEventBus.onConfigChange(listener);

  return {
    unsubscribe() {
      if (timer !== null) clearTimeout(timer);
      unsub();
    },
  };
}
