import type {
  ILimbNode,
  LimbCapability,
  LimbCommandSchema,
  LimbInvocationContext,
  LimbInvokeResult,
  LimbNodeStatus,
} from '@cat-cafe/shared';
import type { LimbDeclaration } from '../../domains/limb/limb-yaml-loader.js';
import { PluginLimbAdapter } from '../../domains/limb/PluginLimbAdapter.js';
import { createWeChatVisibleReaderHandlers } from './handlers.js';
import type { WeChatVisibleReaderNativeRunner } from './native-runner.js';
import type { WeChatVisibleReaderArmStore } from './WeChatVisibleReaderArmStore.js';
import type { WeChatVisibleReaderMetrics } from './WeChatVisibleReaderMetrics.js';

export interface WeChatVisibleReaderLimbNodeOptions {
  declaration: LimbDeclaration;
  armStore: WeChatVisibleReaderArmStore;
  metrics: WeChatVisibleReaderMetrics;
  runner: WeChatVisibleReaderNativeRunner;
  platform?: NodeJS.Platform;
}

export class WeChatVisibleReaderLimbNode implements ILimbNode {
  readonly nodeId: string;
  readonly displayName: string;
  readonly platform: string;
  readonly capabilities: LimbCapability[];
  readonly commandSchemas: Readonly<Record<string, LimbCommandSchema>>;

  private readonly adapter: PluginLimbAdapter;
  private readonly runner: WeChatVisibleReaderNativeRunner;
  private readonly hostPlatform: NodeJS.Platform;

  constructor(options: WeChatVisibleReaderLimbNodeOptions) {
    this.runner = options.runner;
    this.hostPlatform = options.platform ?? process.platform;
    this.adapter = new PluginLimbAdapter({
      declaration: options.declaration,
      pluginConfig: {},
      handlers: createWeChatVisibleReaderHandlers({
        armStore: options.armStore,
        metrics: options.metrics,
        runner: options.runner,
      }),
    });
    this.nodeId = this.adapter.nodeId;
    this.displayName = this.adapter.displayName;
    this.platform = this.adapter.platform;
    this.capabilities = this.adapter.capabilities;
    this.commandSchemas = this.adapter.commandSchemas;
  }

  register(): Promise<void> {
    return this.adapter.register();
  }

  deregister(): Promise<void> {
    return this.adapter.deregister();
  }

  async invoke(
    command: string,
    params: Record<string, unknown>,
    context?: LimbInvocationContext,
  ): Promise<LimbInvokeResult> {
    if (this.hostPlatform !== 'darwin') {
      return { success: false, error: 'WeChat visible reader is available only on macOS' };
    }
    return this.adapter.invoke(command, params, context);
  }

  async healthCheck(): Promise<LimbNodeStatus> {
    if (this.hostPlatform !== 'darwin') return 'offline';
    const probe = await this.runner.probe();
    return probe.ok ? 'online' : 'degraded';
  }
}
