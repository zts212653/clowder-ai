import type { ILimbNode } from '@cat-cafe/shared';

import { loadLimbDeclaration } from '../../domains/limb/limb-yaml-loader.js';
import type { WeChatVisibleReaderNativeRunner } from './native-runner.js';
import type { WeChatVisibleReaderArmStore } from './WeChatVisibleReaderArmStore.js';
import { WeChatVisibleReaderLimbNode } from './WeChatVisibleReaderLimbNode.js';
import type { WeChatVisibleReaderMetrics } from './WeChatVisibleReaderMetrics.js';

export type WeChatVisibleReaderPluginLimbFactory = (
  yamlPath: string,
  pluginConfig: Record<string, string>,
) => Promise<ILimbNode>;

export interface WeChatVisibleReaderFactoryOptions {
  armStore: WeChatVisibleReaderArmStore;
  metrics: WeChatVisibleReaderMetrics;
  runner: WeChatVisibleReaderNativeRunner;
  platform?: NodeJS.Platform;
}

export function createWeChatVisibleReaderLimbFactory(
  options: WeChatVisibleReaderFactoryOptions,
): WeChatVisibleReaderPluginLimbFactory {
  const platform = options.platform ?? process.platform;
  return async (yamlPath) => {
    if (platform !== 'darwin') {
      throw new Error('WeChat visible reader is available only on macOS');
    }
    const probe = await options.runner.probe();
    if (!probe.ok) {
      throw new Error(`WeChat visible reader unavailable: ${probe.error.code}`);
    }
    return new WeChatVisibleReaderLimbNode({
      declaration: loadLimbDeclaration(yamlPath),
      armStore: options.armStore,
      metrics: options.metrics,
      runner: options.runner,
      platform,
    });
  };
}

export function registerWeChatVisibleReaderLimbFactory(
  registry: Map<string, WeChatVisibleReaderPluginLimbFactory>,
  options: WeChatVisibleReaderFactoryOptions,
): void {
  registry.set('wechat-visible-reader', createWeChatVisibleReaderLimbFactory(options));
}
