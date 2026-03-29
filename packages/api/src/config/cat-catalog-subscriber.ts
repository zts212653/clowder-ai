/**
 * Cat Catalog Subscriber — F136 Phase 3A
 *
 * Subscribes to configEventBus for cat-config changes and triggers
 * registry reconciliation. Replaces the inline callback pattern
 * (onCatalogChanged) that was previously wired through route options.
 *
 * Design:
 * - Returns Promise from listener so emitChangeAsync can await it (P1-1 fix)
 * - Serializes concurrent reconciles via promise chain (P1-2 fix)
 */

import { type ConfigChangeEvent, configEventBus } from './config-event-bus.js';

export interface CatCatalogSubscriberOpts {
  onReconcile: () => Promise<void>;
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
}

export interface CatCatalogSubscriberHandle {
  unsubscribe(): void;
}

function isCatCatalogChange(event: ConfigChangeEvent): boolean {
  return event.source === 'cat-config';
}

export function createCatCatalogSubscriber(opts: CatCatalogSubscriberOpts): CatCatalogSubscriberHandle {
  let pending: Promise<void> = Promise.resolve();

  const listener = (event: ConfigChangeEvent): Promise<void> | void => {
    if (!isCatCatalogChange(event)) return;
    opts.log.info('[CatCatalogSubscriber] Cat catalog changed, reconciling registry...');
    // Chain onto previous reconcile — serializes concurrent events (P1-2)
    pending = pending
      .then(() => opts.onReconcile())
      .catch((err) => {
        opts.log.warn('[CatCatalogSubscriber] Reconcile failed:', err);
      });
    // Return promise so emitChangeAsync can await it (P1-1)
    return pending;
  };

  const unsub = configEventBus.onConfigChange(listener);

  return {
    unsubscribe() {
      unsub();
    },
  };
}
