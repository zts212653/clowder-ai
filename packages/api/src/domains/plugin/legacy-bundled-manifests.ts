import { deploymentDefaults } from '@cat-cafe/shared';

/** Frozen manifest-only registrations preceding archive releases. Never derive these from a newer release. */
export const LEGACY_BUNDLED_MANIFESTS = [
  {
    pluginId: 'official.collective-connector',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'Collective Connector',
    description: `Pairs this ${deploymentDefaults.brand.displayName} Host with an independent Collective Service.`,
    features: [
      {
        id: 'collective-connection',
        name: 'Collective connection',
        resources: [],
        capabilities: [],
      },
    ],
    data: [
      {
        name: 'collective-connections',
        dataClass: 'relationship',
        strategy: 'retained',
        schemaVersion: '1',
      },
      {
        name: 'collective-signal-custody',
        dataClass: 'interaction-history',
        strategy: 'retained',
        schemaVersion: '1',
      },
    ],
    runtime: {
      transport: 'builtin',
    },
  },
  {
    pluginId: 'official.chatgpt-dot',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'ChatGPT 云端',
    description: 'Pro 与 dot 共用已连接的猫咖插件。在这里为目标 dot 准备召唤订阅，回复和原图回到原对话。',
    features: [
      {
        id: 'dot-connection',
        name: 'dot 连接',
        resources: [],
        capabilities: [],
      },
    ],
    data: [
      {
        name: 'dot-connection',
        dataClass: 'relationship',
        strategy: 'retained',
        schemaVersion: '1',
      },
      {
        name: 'dot-dispatch',
        dataClass: 'interaction-history',
        strategy: 'retained',
        schemaVersion: '1',
      },
    ],
    runtime: {
      transport: 'builtin',
    },
  },
] as const;
