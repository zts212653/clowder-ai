import type { FastifyBaseLogger } from 'fastify';
import { CiCdCheckPoller } from './CiCdCheckPoller.js';
import type { CiCdRouter } from './CiCdRouter.js';
import type { ConnectorInvokeTrigger } from './ConnectorInvokeTrigger.js';
import type { IPrTrackingStore } from './PrTrackingStore.js';

let poller: CiCdCheckPoller | null = null;

export interface GithubCiBootstrapOptions {
  readonly prTrackingStore: IPrTrackingStore;
  readonly cicdRouter: CiCdRouter;
  readonly invokeTrigger?: ConnectorInvokeTrigger;
  readonly log: FastifyBaseLogger;
  readonly pollIntervalMs?: number;
}

export function startGithubCiPoller(options: GithubCiBootstrapOptions): boolean {
  if (poller) {
    options.log.warn('[GithubCiPoller] Already running, skipping');
    return false;
  }

  poller = new CiCdCheckPoller({
    prTrackingStore: options.prTrackingStore,
    cicdRouter: options.cicdRouter,
    invokeTrigger: options.invokeTrigger,
    log: options.log,
    pollIntervalMs: options.pollIntervalMs,
  });

  poller.start();
  options.log.info('[GithubCiPoller] Started');
  return true;
}

export function stopGithubCiPoller(): void {
  if (poller) {
    poller.stop();
    poller = null;
  }
}

export function isGithubCiPollerRunning(): boolean {
  return poller !== null;
}
