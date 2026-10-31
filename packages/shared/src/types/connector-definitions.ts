/**
 * Built-in (compile-time) connector definitions.
 * Split from connector.ts so registry types and lookup stay under the file-size
 * budget; only Host-owned notice identities are defined here. Plugins declare their own identity.
 */
import { deploymentDefaults } from '../deployment-defaults.js';
import type { ConnectorDefinition } from './connector.js';

export const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = [
  // ── System connectors ──
  {
    id: 'vote-result',
    displayName: '投票结果',
    icon: { type: 'svg', iconId: 'ballot' },
    themeColor: '#7C3AED',
    description: '投票系统自动汇总结果',
  },
  {
    id: 'multi-mention-result',
    displayName: 'Multi-Mention 结果',
    icon: { type: 'svg', iconId: 'users' },
    themeColor: '#059669',
    description: '多猫 @mention 聚合结果',
  },
  {
    id: 'scheduler',
    displayName: '定时任务',
    icon: { type: 'svg', iconId: 'scheduler' },
    themeColor: '#F59E0B',
    description: '定时任务投递',
  },
  {
    id: 'hold-ball',
    displayName: '持球通知',
    icon: { type: 'svg', iconId: 'hold-ball' },
    themeColor: '#D97706',
    description: '猫猫持球等待中',
  },
  {
    id: 'callback-auth',
    displayName: '认证回调',
    icon: { type: 'svg', iconId: 'auth-key' },
    themeColor: '#475569',
    description: '外部回调认证通知',
  },
  {
    id: 'system-command',
    displayName: `${deploymentDefaults.brand.displayName}`,
    icon: { type: 'svg', iconId: 'settings' },
    themeColor: '#6B7280',
    description: '系统命令响应',
  },
  {
    id: 'frustration-auto-issue',
    displayName: '问题检测',
    icon: { type: 'svg', iconId: 'search' },
    themeColor: '#B45309',
    description: '自动问题检测与反馈卡',
  },
  {
    id: 'content-review',
    displayName: '产物审阅',
    icon: { type: 'svg', iconId: 'search' },
    themeColor: '#7C3AED',
    description: '人的审阅或修改请求交回原任务（Host 回执）',
  },
  {
    id: 'development-return',
    displayName: '开发结果回流',
    icon: { type: 'svg', iconId: 'return-arrow' },
    themeColor: '#475569',
    description: '执行现场回报原负责人核验或复核',
  },
  {
    id: 'deployment-wait',
    displayName: 'Deployment Wait',
    icon: { type: 'svg', iconId: 'refresh-cw' },
    themeColor: '#475569',
    description: '部署条件满足后接回原任务',
  },
  {
    id: 'worktree-lifecycle',
    displayName: '工位通知',
    icon: { type: 'svg', iconId: 'settings' },
    themeColor: '#6B7280',
    description: '工位保留、清理及恢复结果',
  },
  {
    id: 'physical-limb.stackchan',
    displayName: 'StackChan',
    icon: { type: 'svg', iconId: 'robot' },
    themeColor: '#0F766E',
    description: '物理 Limb 转写通知',
  },
] as const;
