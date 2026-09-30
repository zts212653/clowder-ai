import type { Capability } from '@clowder-ai/plugin-contract';
import type { MachineCatalogHostPolicy } from './machine-catalog-provider.js';

/**
 * The capabilities an official IM connector uses, each for one of its shipped features. A
 * connector is listed below with the ones its package actually calls (verified per package for
 * F202 W2-6); the Host grants nothing else, whatever a later manifest asks for.
 *
 * - `plugin.config.read`, `secret.read`: its connection settings and credentials.
 * - `plugin.state.get`, `plugin.state.set`: its private state — lifecycle bookkeeping for
 *   placeholders and receipts, and the ownership records of inbound media.
 * - `media.read`: Host media it sends out (W2-5b); each read is still checked per instance and
 *   per media item.
 * - `message.event.subscribe`, `messaging.send`: thread activity out to the platform, and platform
 *   messages into their threads.
 * - `thread.listMetadata`, `thread.write`: the thread bindings and the connector's system thread.
 */
const CONNECTOR_GRANTS = [
  'plugin.config.read',
  'plugin.state.get',
  'plugin.state.set',
  'media.read',
  'message.event.subscribe',
  'messaging.send',
  'secret.read',
  'thread.listMetadata',
  'thread.write',
] as const satisfies readonly Capability[];

function connectorGrants(...unused: readonly (typeof CONNECTOR_GRANTS)[number][]): readonly Capability[] {
  return CONNECTOR_GRANTS.filter((capability) => !unused.includes(capability));
}

/**
 * Host-owned grant policy for official plugins, applied alike to catalog installs and to
 * owner-selected local packages, and reconciled onto installed instances at startup. A package can
 * only ever receive what its entry lists and its manifest requests.
 */
export const OFFICIAL_PLUGIN_HOST_POLICIES: readonly MachineCatalogHostPolicy[] = [
  { pluginId: 'official.connector.dingtalk', effectiveGrants: connectorGrants() },
  { pluginId: 'official.connector.feishu', effectiveGrants: connectorGrants() },
  // Telegram takes its settings from its credentials alone; it reads no plain configuration.
  { pluginId: 'official.connector.telegram', effectiveGrants: connectorGrants('plugin.config.read') },
  { pluginId: 'official.connector.wecom-agent', effectiveGrants: connectorGrants() },
  { pluginId: 'official.connector.wecom-bot', effectiveGrants: connectorGrants() },
  { pluginId: 'official.connector.weixin', effectiveGrants: connectorGrants() },
  // XiaoYi sends no media.
  { pluginId: 'official.connector.xiaoyi', effectiveGrants: connectorGrants('media.read') },
  {
    pluginId: 'official.wechat-visible-reader',
    effectiveGrants: ['plugin.state.get', 'plugin.state.set'],
  },
  {
    pluginId: 'official.enterprise-workflow',
    effectiveGrants: ['plugin.config.read'],
  },
  {
    pluginId: 'official.weixin-mp',
    replacesRepositoryPluginId: 'weixin-mp',
    effectiveGrants: ['plugin.config.read', 'secret.read'],
  },
  {
    pluginId: 'dev.clowder.video-generation',
    replacesRepositoryPluginId: 'video-gen',
    effectiveGrants: ['plugin.config.read', 'secret.read'],
  },
  {
    pluginId: 'dev.clowder.video-analysis',
    effectiveGrants: ['plugin.config.read', 'secret.read'],
  },
];
