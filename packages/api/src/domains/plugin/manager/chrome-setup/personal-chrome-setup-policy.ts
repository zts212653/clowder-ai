import type { PluginPackageRecord } from '../../host-inventory/types.js';
import type { ContractOperationField } from '../plugin-manager-field-projection.js';

const PLUGIN_ID = 'official.companion.personal-chrome';
const OPERATION_KEY = 'hostChromeSetup';
// Reviewed self-contained delivery only. SHA256 8ad23a495891fb864b3c86d4e56e7ccb6dab3de7b729b776dfff26543ffa688c.
// Old 9c034 and arbitrary same-version packages cannot gain HOME authority.
export const TRUSTED_CHROME_SETUP_DELIVERY = Object.freeze({
  version: '0.1.0-alpha.4',
  digest: 'sha512-JaN+5NroQcz6r0qyocd9AeS5GZNAUqZLdbGeVVgr8tTTWsGmE5XD3Bds8+tND2WbeGOcUWx/im5iyULAFilA2A==',
});

/** Routing is not authorization: both projection and execution resolve the policy below. */
export function isChromeSetupRequest(pluginId: string, key: string): boolean {
  return pluginId === PLUGIN_ID && key === OPERATION_KEY;
}

/** Host-owned declaration, never inserted into the plugin manifest or its SDK action table. */
export function chromeSetupPolicy(record: PluginPackageRecord): ContractOperationField | undefined {
  if (
    record.packageState !== 'installed' ||
    record.pluginId !== PLUGIN_ID ||
    record.version !== TRUSTED_CHROME_SETUP_DELIVERY.version ||
    record.packageDigest !== TRUSTED_CHROME_SETUP_DELIVERY.digest ||
    record.manifest?.pluginId !== PLUGIN_ID ||
    record.manifest.version !== TRUSTED_CHROME_SETUP_DELIVERY.version
  )
    return;
  return {
    key: OPERATION_KEY,
    kind: 'operation',
    label: 'Chrome connection',
    required: false,
    description: '安装本机连接，再在 Chrome 中加载扩展并授权指定对话。安装成功不代表浏览器已连接。',
    actions: [
      {
        id: 'inspect',
        label: '检查 Chrome 连接安装',
        render: 'status',
        resultRender: 'rows',
        action: { method: 'host.personalChromeSetup.inspect' },
      },
      {
        id: 'install',
        label: '安装或修复 Chrome 连接',
        render: 'button',
        next: 'inspect',
        action: { method: 'host.personalChromeSetup.install' },
        confirm: '为当前安装注册本机 Chrome 辅助程序并准备扩展？不会启动 Chrome 或授权任何对话。',
      },
      {
        id: 'uninstall',
        label: '移除 Chrome 连接',
        render: 'button',
        next: 'inspect',
        action: { method: 'host.personalChromeSetup.uninstall' },
        confirm: '请先关闭 Chrome。移除此安装的本机连接？已有授权记录和历史将保留。',
      },
    ],
  };
}
