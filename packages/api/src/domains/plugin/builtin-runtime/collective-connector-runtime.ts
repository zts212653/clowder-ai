import { resolve } from 'node:path';

import {
  CollectiveConnector,
  type CollectiveConnectorOptions,
  type VerifiedAgent,
} from '@cat-cafe/collective-connector';

import type { BuiltinPluginRuntime } from './hybrid-supervisor.js';

export interface CollectiveConnectorBuiltinRuntimeOptions {
  readonly dataDirectory: string;
  readonly verifyAgent: (agent: VerifiedAgent) => Promise<boolean>;
  readonly syncIntervalMs?: number;
  readonly now?: () => number;
  readonly openConnector?: (options: CollectiveConnectorOptions) => Promise<CollectiveConnector>;
  readonly createIngressDispatcher?: (connector: CollectiveConnector) => {
    dispatchConnection(connectionId: string): Promise<unknown>;
  };
}

export class CollectiveConnectorBuiltinRuntime implements BuiltinPluginRuntime {
  readonly #dataDirectory: string;
  readonly #syncIntervalMs: number;
  #connector: CollectiveConnector | undefined;
  #instanceId: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #ingressDispatcher: { dispatchConnection(connectionId: string): Promise<unknown> } | undefined;

  constructor(private readonly options: CollectiveConnectorBuiltinRuntimeOptions) {
    this.#dataDirectory = resolve(options.dataDirectory);
    this.#syncIntervalMs = options.syncIntervalMs ?? 2_000;
  }

  async start(pluginInstanceId: string): Promise<void> {
    if (this.#instanceId) throw new Error('Collective Connector builtin runtime is already active');
    const openConnector =
      this.options.openConnector ?? ((options: CollectiveConnectorOptions) => CollectiveConnector.open(options));
    this.#connector = await openConnector({
      dataDirectory: this.#dataDirectory,
      verifyAgent: this.options.verifyAgent,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
    this.#ingressDispatcher = this.options.createIngressDispatcher?.(this.#connector);
    this.#instanceId = pluginInstanceId;
    this.#timer = setInterval(() => {
      void this.syncAll();
    }, this.#syncIntervalMs);
    this.#timer.unref();
    void this.syncAll();
  }

  async stop(pluginInstanceId: string, _reason: string): Promise<void> {
    if (this.#instanceId !== pluginInstanceId) return;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#connector = undefined;
    this.#ingressDispatcher = undefined;
    this.#instanceId = undefined;
  }

  connector(): CollectiveConnector | undefined {
    return this.#connector;
  }

  private async syncAll(): Promise<void> {
    const connector = this.#connector;
    if (!connector) return;
    const connections = await connector.listConnections();
    await Promise.all(
      connections
        .filter((connection) => connection.authorityStatus !== 'revoked')
        .map(async (connection) => {
          await connector.sync(connection.connectionId).catch(() => undefined);
          await this.#ingressDispatcher?.dispatchConnection(connection.connectionId).catch(() => undefined);
        }),
    );
  }
}
