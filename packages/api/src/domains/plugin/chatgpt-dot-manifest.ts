import { CHATGPT_CLOUD_ENTRY_LABEL } from '@cat-cafe/shared';

export const CHATGPT_DOT_PLUGIN_ID = 'official.chatgpt-dot';

export const CHATGPT_DOT_PLUGIN_MANIFEST = {
  pluginId: CHATGPT_DOT_PLUGIN_ID,
  version: '0.1.2',
  contractVersion: '0.1.0',
  name: CHATGPT_CLOUD_ENTRY_LABEL,
  icon: { type: 'svg', src: 'assets/chatgpt-cloud.svg' },
  description: 'Pro 与 dot 共用已连接的猫咖插件。在这里为目标 dot 准备召唤订阅，回复和原图回到原对话。',
  features: [{ id: 'dot-connection', name: 'dot 连接', resources: [], capabilities: [] }],
  data: [
    { name: 'dot-connection', dataClass: 'relationship', strategy: 'retained', schemaVersion: '1' },
    { name: 'dot-dispatch', dataClass: 'interaction-history', strategy: 'retained', schemaVersion: '1' },
  ],
  runtime: { transport: 'builtin' },
} as const;
