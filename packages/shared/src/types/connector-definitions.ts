/**
 * Built-in (compile-time) connector definitions.
 * Split from connector.ts so registry types and lookup stay under the file-size
 * budget; entries and their order are unchanged.
 */
import type { ConnectorDefinition } from './connector.js';

export const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = [
  // ── GitHub connectors ──
  {
    id: 'github-review',
    displayName: 'GitHub Review',
    icon: { type: 'svg', iconId: 'github' },
    themeColor: '#778899',
    description: 'GitHub PR review 邮件通知',
  },
  {
    id: 'github-ci',
    displayName: 'GitHub CI/CD',
    icon: { type: 'svg', iconId: 'github' },
    themeColor: '#778899',
    description: 'GitHub CI/CD 状态通知',
  },
  {
    id: 'github-conflict',
    displayName: 'PR Conflict',
    icon: { type: 'svg', iconId: 'github' },
    themeColor: '#475569',
    description: 'GitHub PR 冲突状态通知',
  },
  {
    id: 'github-review-feedback',
    displayName: 'Review Feedback',
    icon: { type: 'svg', iconId: 'github' },
    themeColor: '#64748B',
    description: 'GitHub PR review feedback 通知',
  },
  {
    id: 'github-issue-comment',
    displayName: 'Issue Comment',
    icon: { type: 'svg', iconId: 'github' },
    themeColor: '#778899',
    description: 'GitHub issue comment 通知',
  },
  {
    id: 'github-repo-event',
    displayName: 'Repo Inbox',
    icon: { type: 'svg', iconId: 'github' },
    themeColor: '#94A3B8',
    description: 'GitHub 仓库事件通知（新 PR / 新 Issue）',
  },
  {
    id: 'github-wait',
    displayName: 'GitHub Wait',
    icon: { type: 'svg', iconId: 'github' },
    themeColor: '#778899',
    description: 'GitHub PR 等待条件满足通知',
  },
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
    displayName: 'Clowder AI',
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
    id: 'physical-limb.stackchan',
    displayName: 'StackChan',
    icon: { type: 'svg', iconId: 'robot' },
    themeColor: '#0F766E',
    description: '物理 Limb 转写通知',
  },
  // ── IM connectors (PNG icons) ──
  {
    id: 'feishu',
    displayName: '飞书',
    icon: { type: 'png', src: '/images/connectors/feishu.png' },
    themeColor: '#3370FF',
    description: '飞书机器人',
  },
  {
    id: 'telegram',
    displayName: 'Telegram',
    icon: { type: 'png', src: '/images/connectors/telegram.png' },
    themeColor: '#0088CC',
    description: 'Telegram Bot',
  },
  {
    id: 'dingtalk',
    displayName: '钉钉',
    icon: { type: 'png', src: '/images/connectors/dingtalk.png' },
    themeColor: '#3296FA',
    description: '钉钉企业内部应用',
  },
  {
    id: 'xiaoyi',
    displayName: '小艺 APP',
    icon: { type: 'png', src: '/images/connectors/xiaoyi.png' },
    themeColor: '#CF0A2C',
    description: '华为小艺 OpenClaw 模式',
  },
  {
    id: 'wecom-bot',
    displayName: '企业微信',
    icon: { type: 'png', src: '/images/connectors/wecom-bot.png' },
    themeColor: '#4F46E5',
    description: '企业微信智能机器人 (WebSocket)',
  },
  {
    id: 'wecom-agent',
    displayName: '企微自建应用',
    icon: { type: 'png', src: '/images/connectors/wecom-agent.png' },
    themeColor: '#7C3AED',
    description: '企业微信自建应用 (HTTP 回调)',
  },
  {
    id: 'weixin',
    displayName: '微信',
    icon: { type: 'png', src: '/images/connectors/weixin.png' },
    themeColor: '#07C160',
    description: '微信个人号 iLink Bot',
  },
] as const;
