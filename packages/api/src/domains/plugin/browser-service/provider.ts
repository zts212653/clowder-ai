import type { RequestListener } from 'node:http';
import type { BrowserServiceContribution } from '@clowder-ai/plugin-contract';
import { admitModuleBrowserServices } from '../builtin-runtime/carriers/module-browser-services.js';
import type {
  ModuleBrowserServiceActivationInput,
  ModuleBrowserServiceSession,
  PluginBrowserServiceBinding,
  PluginBrowserServiceHandler,
  PluginBrowserServiceHost,
} from '../host-surface/plugin-browser-service-host.js';
import { BrowserServiceDispatchBudget, BrowserServiceDispatcher } from './dispatch.js';
import { closeBrowserEndpoint, reserveBrowserEndpoint } from './endpoint-reservation.js';
import { createBrowserOriginEndpoint, createBrowserRequestHandler } from './http-endpoint.js';
import type { RetainedBrowserAssets } from './retained-assets.js';
import { BROWSER_SERVICE_LIMITS, BrowserServiceTransportError } from './transport-policy.js';

interface Options {
  readonly identityDirectory: string;
  readonly parentOrigin: string;
  /** First-party catalog resolver. No plugin-controlled filesystem path is accepted here. */
  assets(
    input: ModuleBrowserServiceActivationInput,
    contribution: BrowserServiceContribution,
  ): Promise<RetainedBrowserAssets>;
}
function refuse(code: 'BROWSER_SERVICE_UNAVAILABLE' | 'BROWSER_SERVICE_REVOKED'): never {
  throw new BrowserServiceTransportError(code);
}
interface Endpoint {
  readonly binding: PluginBrowserServiceBinding;
  readonly dispatch: BrowserServiceDispatcher;
  publish(handler: PluginBrowserServiceHandler): void;
  close(): Promise<void>;
}

interface OwnedOrigin {
  readonly server: ReturnType<typeof createBrowserOriginEndpoint>;
  readonly origin: string;
  request: RequestListener | undefined;
}

/** One provider per Host owns the global budget, endpoint assignments and active reservations. */
export class PluginBrowserServiceProvider {
  readonly #budget = new BrowserServiceDispatchBudget();
  readonly #reserved = new Set<string>();
  readonly #origins = new Map<string, OwnedOrigin>();
  readonly #hostLife = new AbortController();
  readonly #preparing = new Set<Promise<ModuleBrowserServiceSession>>();
  constructor(private readonly options: Options) {
    const parent = new URL(options.parentOrigin);
    if (!['http:', 'https:'].includes(parent.protocol) || parent.origin !== options.parentOrigin)
      refuse('BROWSER_SERVICE_UNAVAILABLE');
  }

  prepare(input: ModuleBrowserServiceActivationInput): Promise<ModuleBrowserServiceSession> {
    if (this.#hostLife.signal.aborted)
      return Promise.reject(new BrowserServiceTransportError('BROWSER_SERVICE_UNAVAILABLE'));
    const operation = this.#prepare(input);
    this.#preparing.add(operation);
    const done = () => {
      this.#preparing.delete(operation);
    };
    void operation.then(done, done);
    return operation;
  }

  /** Only final Host teardown releases origins. Plugin stop and failed activation do not. */
  async shutdown(): Promise<void> {
    this.#hostLife.abort();
    await Promise.allSettled([...this.#preparing]);
    const errors: unknown[] = [];
    for (const [key, owned] of this.#origins) {
      owned.request = undefined;
      try {
        await closeBrowserEndpoint(owned.server);
        this.#origins.delete(key);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Browser origin shutdown failed');
  }

  async #prepare(input: ModuleBrowserServiceActivationInput): Promise<ModuleBrowserServiceSession> {
    const active = admitModuleBrowserServices(input.packageRecord.manifest, input.effectiveGrants).active;
    const endpoints = new Map<string, Endpoint>();
    const life = new AbortController();
    const signal = AbortSignal.any([life.signal, input.signal, this.#hostLife.signal]);
    let stopped = false,
      published = false;
    const assertCurrent = async () => {
      if (signal.aborted || stopped) refuse('BROWSER_SERVICE_REVOKED');
      try {
        await input.assertCurrent();
      } catch {
        refuse('BROWSER_SERVICE_REVOKED');
      }
    };
    const stop = async () => {
      stopped = true;
      life.abort();
      const errors: unknown[] = [];
      for (const [id, endpoint] of endpoints) {
        try {
          await endpoint.close();
          endpoints.delete(id);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Browser service close failed');
    };
    try {
      await assertCurrent();
      for (const contribution of active.values()) {
        const endpoint = await this.#prepareEndpoint(input, contribution, signal, assertCurrent);
        endpoints.set(contribution.id, endpoint);
        await assertCurrent();
      }
      const endpointFor = async (id: string) => {
        await assertCurrent();
        const endpoint = endpoints.get(id);
        if (!endpoint) refuse('BROWSER_SERVICE_UNAVAILABLE');
        return endpoint;
      };
      return {
        host: Object.freeze<PluginBrowserServiceHost>({
          getBinding: async (id: string) => (await endpointFor(id)).binding,
          dispatchLocal: async (id, request, options) => {
            try {
              return await (await endpointFor(id)).dispatch.dispatch('local', request, options?.signal);
            } catch {
              return {
                kind: 'transport-error',
                code: signal.aborted ? 'BROWSER_SERVICE_REVOKED' : 'BROWSER_SERVICE_UNAVAILABLE',
                effect: 'not_started',
                automaticRetry: false,
              };
            }
          },
        }),
        publish: async (handlers) => {
          await assertCurrent();
          if (
            published ||
            handlers.size !== endpoints.size ||
            [...endpoints.keys()].some((id) => typeof handlers.get(id) !== 'function')
          )
            refuse('BROWSER_SERVICE_UNAVAILABLE');
          for (const [id, endpoint] of endpoints) {
            const handler = handlers.get(id);
            if (!handler) refuse('BROWSER_SERVICE_UNAVAILABLE');
            endpoint.publish(handler);
          }
          published = true;
        },
        stop,
      };
    } catch (error) {
      try {
        await stop();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Browser service preparation failed');
      }
      throw error;
    }
  }

  async #prepareEndpoint(
    input: ModuleBrowserServiceActivationInput,
    contribution: BrowserServiceContribution,
    signal: AbortSignal,
    assertCurrent: () => Promise<void>,
  ): Promise<Endpoint> {
    const key = JSON.stringify([input.pluginInstanceId, contribution.id]);
    if (this.#reserved.has(key)) refuse('BROWSER_SERVICE_UNAVAILABLE');
    this.#reserved.add(key);
    let owned: OwnedOrigin | undefined;
    try {
      const assets = await this.options.assets(input, contribution);
      await assertCurrent();
      owned = this.#origins.get(key);
      if (!owned) {
        let request: RequestListener | undefined;
        const server = createBrowserOriginEndpoint(() => request);
        const origin = await reserveBrowserEndpoint(
          server,
          this.options.identityDirectory,
          input.pluginInstanceId,
          contribution.id,
        );
        // Once persisted, this identity may already have browser state from an earlier Host lifetime.
        // Keep it owned even if this activation subsequently fails before publication.
        owned = {
          server,
          origin,
          get request() {
            return request;
          },
          set request(value) {
            request = value;
          },
        };
        this.#origins.set(key, owned);
      }
      await assertCurrent();
      const origin = owned.origin;
      let handler: PluginBrowserServiceHandler | undefined;
      const binding = Object.freeze({
        contributionId: contribution.id,
        origin,
        parentOrigin: this.options.parentOrigin,
        clientBuildId: assets.clientBuildId,
        assetDigest: assets.assetDigest,
        limits: BROWSER_SERVICE_LIMITS,
        assertCurrent,
      });
      const dispatcher = new BrowserServiceDispatcher({
        instanceId: input.pluginInstanceId,
        contribution,
        binding,
        activationSignal: signal,
        budget: this.#budget,
        handler: () => handler,
      });
      const ownedOrigin = owned;
      let detached = false;
      ownedOrigin.request = createBrowserRequestHandler({
        parentOrigin: this.options.parentOrigin,
        contribution,
        assets,
        signal,
        origin: () => origin,
        published: () => handler !== undefined,
        assertCurrent,
        dispatcher: () => dispatcher,
      });
      return {
        binding,
        dispatch: dispatcher,
        publish(value) {
          handler = value;
        },
        close: async () => {
          if (detached) return;
          detached = true;
          handler = undefined;
          ownedOrigin.request = undefined;
          this.#reserved.delete(key);
        },
      };
    } catch (error) {
      if (owned) owned.request = undefined;
      this.#reserved.delete(key);
      throw error;
    }
  }
}
