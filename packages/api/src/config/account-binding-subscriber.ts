/**
 * Account Binding Subscriber — F136 Phase 4c
 *
 * Subscribes to configEventBus for accounts changes and triggers
 * provider rebinding for affected cats. Follows CatCatalogSubscriber pattern:
 * - Returns Promise from listener so emitChangeAsync can await it
 * - Serializes concurrent rebinds via promise chain
 */

import { type ConfigChangeEvent, configEventBus } from './config-event-bus.js';

export interface AccountBindingSubscriberOpts {
  onRebind: (changedAccountRefs: string[]) => Promise<void>;
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
}

export interface AccountBindingSubscriberHandle {
  unsubscribe(): void;
}

function isAccountsChange(event: ConfigChangeEvent): boolean {
  return event.source === 'accounts';
}

export function createAccountBindingSubscriber(opts: AccountBindingSubscriberOpts): AccountBindingSubscriberHandle {
  let pending: Promise<void> = Promise.resolve();

  const listener = (event: ConfigChangeEvent): Promise<void> | void => {
    if (!isAccountsChange(event)) return;
    opts.log.info(`[AccountBindingSubscriber] Accounts changed [${event.changedKeys.join(', ')}], rebinding...`);
    pending = pending
      .then(() => opts.onRebind(event.changedKeys))
      .catch((err) => {
        opts.log.warn('[AccountBindingSubscriber] Rebind failed:', err);
      });
    return pending;
  };

  const unsub = configEventBus.onConfigChange(listener);

  return {
    unsubscribe() {
      unsub();
    },
  };
}
