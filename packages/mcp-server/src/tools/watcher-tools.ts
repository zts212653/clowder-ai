import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';

const defineMcpTool = defineMcpCanonicalFactory('watcher-tools.ts', undefined, {
  resourceFamily: 'thread-message',
  authority: 'callback-thread',
});

export function handleWatcherNudge(input: Record<string, unknown>) {
  return callbackPost('/api/callbacks/watcher-nudge', input);
}

export const watcherTools = [
  defineMcpTool({
    name: 'cat_cafe_watcher_nudge',
    description:
      '守望猫向刚结束工作的猫递一句有出处的提醒。Use when: 发现一个具体遗漏、先例或有帮助的下一步，值得让工作猫带进下一轮。NOT for: 派任务、找任意成员、改动原请求、代人决策或在免打扰时说话。Output: 同一对话中的一条虚线提醒与普通投递回执；忙碌的猫下一轮收到，已停下的猫由普通 @ 唤醒。',
    inputSchema: {
      type: 'object',
      properties: {
        sentence: {
          type: 'string',
          minLength: 1,
          maxLength: 1200,
          description: '一句具体提醒，不含额外 @ 路由或任务分派。',
        },
        sourceMessageId: { type: 'string', minLength: 1, maxLength: 100, description: '本线原话的 Message ID。' },
      },
      required: ['sentence', 'sourceMessageId'],
      additionalProperties: false,
    },
    handler: handleWatcherNudge,
    governance: {
      implementationExport: 'handleWatcherNudge',
      action: 'nudge',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'authority-boundary',
        admissionRef: 'file:docs/architecture/mcp-evidence/f335-watcher-nudge.md',
      },
    },
  }),
];
