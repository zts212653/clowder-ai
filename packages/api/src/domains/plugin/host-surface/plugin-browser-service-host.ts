import type {
  BrowserServiceDispatchResult,
  BrowserServiceRequest,
  BrowserServiceResponse,
} from '@clowder-ai/plugin-contract';
import type { PluginPackageRecord } from '../host-inventory/types.js';

/** Host-created capability shape, paired with SDK beta.20; it carries no JSON authority. */
export interface PluginBrowserServiceBinding {
  readonly contributionId: string;
  readonly origin: string;
  readonly parentOrigin: string;
  readonly clientBuildId: string;
  readonly assetDigest: string;
  readonly limits: {
    readonly requestBytes: 262144;
    readonly responseBytes: 33554432;
    readonly headerFields: 32;
    readonly headerValueBytes: 8192;
    readonly headerBytes: 32768;
    readonly targetBytes: 8192;
    readonly timeoutMs: 10000;
  };
  assertCurrent(): Promise<void>;
}
export interface PluginBrowserServiceContext {
  readonly kind: 'http';
  readonly lane: 'browser' | 'local';
  readonly contributionId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export type PluginBrowserServiceHandler = (
  input: { readonly request: BrowserServiceRequest },
  nativeContext: undefined,
  context: PluginBrowserServiceContext,
) => Promise<BrowserServiceResponse>;
export interface PluginBrowserServiceHost {
  getBinding(contributionId: string): Promise<PluginBrowserServiceBinding>;
  dispatchLocal(
    contributionId: string,
    request: BrowserServiceRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<BrowserServiceDispatchResult>;
}

/** Internal resource ownership port, never a module-supplied implementation. */
export interface ModuleBrowserServiceSession {
  readonly host: PluginBrowserServiceHost;
  /** Receives only admitted handlers keyed by contribution id, after successful module start. */
  publish(handlers: ReadonlyMap<string, PluginBrowserServiceHandler>): Promise<void>;
  /** Revoke/close serving before package stop; idempotent and retryable after partial failure. */
  stop(reason: string): Promise<void>;
}
export interface ModuleBrowserServiceActivationInput {
  readonly pluginInstanceId: string;
  readonly packageRecord: PluginPackageRecord;
  readonly effectiveGrants: readonly string[];
  readonly signal: AbortSignal;
  assertCurrent(): void | Promise<void>;
}
/** A prepare that rejects must release its own partially acquired resources. */
export type PrepareModuleBrowserServices = (
  input: ModuleBrowserServiceActivationInput,
) => Promise<ModuleBrowserServiceSession>;
