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

// Published alpha.6: SHA256 953f83f057c926f74c35e02c3fbe5e7a19087a77de50f2626e357c6a599f9b22.
// Review and fresh-consumer setup exercise the exact archive, not catalog/name-based HOME authority.
export const TRUSTED_CHROME_SETUP_DELIVERIES = Object.freeze([
  TRUSTED_CHROME_SETUP_DELIVERY,
  Object.freeze({
    version: '0.1.0-alpha.6',
    digest: 'sha512-ypOOdp+jONUH1H9W9qbOLLZVyZ8gXZPs0w4aWuHpTbwhdn1PUIrK4f/DsKwmNyHcrGyq4oF1izrgjC8z8NhN4A==',
  }),
  // Exact alpha.7 archive: SHA256 30686b56939340b8877c52ba363c78a1c98b52885f0265f88bc90f4fa529f808.
  // Its form-scoped send fix retains the reviewed setup runner and permission boundaries.
  Object.freeze({
    version: '0.1.0-alpha.7',
    digest: 'sha512-/lLrNrAsCYEhwHiJuaaiEnG8YIzKGJ+tIX2C8FGFF2BJQd8Rtz6/dg4pXpeVDhUFt16c+7oRitfEnWCGU+Tr+g==',
  }),
  // Exact alpha.8 health fix: SHA256 f79283d3dc1284b602e0b01be11b8d6e51c1271dbaca34fa959ca654601dd995.
  // HOME authority remains limited to this archive and the fixed setup runner.
  Object.freeze({
    version: '0.1.0-alpha.8',
    digest: 'sha512-ePdPiPWIyzscHHi9IDi0WGAZK4a9nvDgW6eGkzHA+4gMRqxusmmqMQf8f+ktoGjGFcHUgG4eeJVTlpwm2bj8lg==',
  }),
]);

/** Routing is not authorization: both projection and execution resolve the policy below. */
export function isChromeSetupRequest(pluginId: string, key: string): boolean {
  return pluginId === PLUGIN_ID && key === OPERATION_KEY;
}

/** Host-owned declaration, never inserted into the plugin manifest or its SDK action table. */
export function chromeSetupPolicy(record: PluginPackageRecord): ContractOperationField | undefined {
  if (
    record.packageState !== 'installed' ||
    record.pluginId !== PLUGIN_ID ||
    record.manifest?.pluginId !== PLUGIN_ID ||
    record.manifest.version !== record.version ||
    !TRUSTED_CHROME_SETUP_DELIVERIES.some(
      ({ version, digest }) => record.version === version && record.packageDigest === digest,
    )
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
