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
 * - `streams.read`: Host media it sends out (W2-5b); each read is still checked per instance and
 *   per media item.
 * - `message.event.subscribe`, `messaging.send`: thread activity out to the platform, and platform
 *   messages into their threads.
 * - `thread.listMetadata`, `thread.write`: the thread bindings and the connector's system thread.
 * - `thread.readContent`: the installed connector's history command; thread access checks still apply.
 */
const CONNECTOR_GRANTS = [
  'plugin.config.read',
  'plugin.state.get',
  'plugin.state.set',
  'streams.read',
  'message.event.subscribe',
  'messaging.send',
  'secret.read',
  'thread.listMetadata',
  'thread.readContent',
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
  { pluginId: 'dev.clowder.genoffice-docx', effectiveGrants: [] },
  {
    pluginId: 'dev.clowder.xiangqi',
    // Verify the human's opening source and chosen conversation/cat; deliver confirmed moves there.
    effectiveGrants: ['thread.readContent', 'thread.listMetadata', 'messaging.send'],
  },
  {
    pluginId: 'official.collective-connector',
    // Shipped Collective features: private state/browser binding, ordinary thread messages,
    // canonical Task data, and subscribed result materials. Each Host port retains its
    // instance/owner/source checks; Task data grants do not select an execution carrier.
    effectiveGrants: [
      // Declared servicePort belongs to this installation; no secret or HOME access.
      'plugin.config.read',
      'thread.readContent',
      'thread.listMetadata',
      'thread.write',
      'messaging.send',
      'task.read',
      'task.write',
      'task.admitEntrusted',
      'plugin.state.get',
      'plugin.state.set',
      'message.event.subscribe',
      'streams.read',
    ],
  },
  {
    pluginId: 'official.companion.personal-chrome',
    effectiveGrants: ['cloud.conversation.host'],
  },
  {
    pluginId: 'official.feishu-meeting-intake',
    // Account configuration, retained records and notifications to an owner-selected thread.
    effectiveGrants: ['plugin.config.read', 'secret.read', 'thread.readContent', 'messaging.send'],
  },
  { pluginId: 'official.connector.dingtalk', effectiveGrants: connectorGrants() },
  { pluginId: 'official.connector.feishu', effectiveGrants: connectorGrants() },
  // Telegram takes its settings from its credentials alone; it reads no plain configuration.
  { pluginId: 'official.connector.telegram', effectiveGrants: connectorGrants('plugin.config.read') },
  { pluginId: 'official.connector.wecom-agent', effectiveGrants: connectorGrants() },
  { pluginId: 'official.connector.wecom-bot', effectiveGrants: connectorGrants() },
  { pluginId: 'official.connector.weixin', effectiveGrants: connectorGrants() },
  // XiaoYi sends no media.
  { pluginId: 'official.connector.xiaoyi', effectiveGrants: connectorGrants('streams.read') },
  {
    pluginId: 'official.github-operations',
    // Owner-approved tracking continuation: generic owner-scoped Task reads and
    // pluginWait CAS writes. No timeline read or entrusted-work admission.
    effectiveGrants: [
      'schedule.register',
      'plugin.config.read',
      'secret.read',
      'plugin.state.get',
      'plugin.state.set',
      'thread.listMetadata',
      'thread.write',
      'messaging.send',
      'task.read',
      'task.write',
    ],
  },
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
    effectiveGrants: ['plugin.config.read', 'secret.read'],
  },
  {
    pluginId: 'dev.clowder.video-generation',
    effectiveGrants: ['plugin.config.read', 'secret.read'],
  },
  {
    pluginId: 'dev.clowder.video-analysis',
    effectiveGrants: ['plugin.config.read', 'secret.read'],
  },
];
