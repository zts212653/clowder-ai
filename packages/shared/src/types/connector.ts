/**
 * Connector Types — 外部信息源 / notice transport 抽象
 *
 * Connector transport covers both:
 * 1) true external systems（GitHub、iMessage、Slack 等）, and
 * 2) thread-visible system notices that reuse the same persistence/socket path.
 *
 * Visual presentation is not implied by storage transport:
 * - default connector messages render as ConnectorBubble
 * - messages with `source.meta.presentation = 'system_notice'` render as in-thread notice bars
 *
 * BACKLOG #97
 */

// ── Connector Source (附加到 StoredMessage) ──

/** Shared prefix for scheduler trigger messages that act as reply anchors. */
export const SCHEDULER_TRIGGER_PREFIX = '[定时任务]';

export type SchedulerLifecycleEvent =
  | 'registered'
  | 'paused'
  | 'resumed'
  | 'deleted'
  | 'succeeded'
  | 'failed'
  | 'missed_window';

export interface SchedulerToastPayload {
  type: 'success' | 'error' | 'info';
  title: string;
  message: string;
  duration: number;
  lifecycleEvent: SchedulerLifecycleEvent;
}

export interface SchedulerMessageExtra {
  scheduler?: {
    hiddenTrigger?: boolean;
    toast?: SchedulerToastPayload;
  };
}

export type ReplyPreviewKind = 'scheduler_trigger';

export interface ReplyPreview {
  senderCatId: string | null;
  content: string;
  deleted?: true;
  kind?: ReplyPreviewKind;
}

/** Source metadata attached to connector-transport messages. */
export interface ConnectorSource {
  /** Stable connector identifier (used for routing + styling) */
  readonly connector: string;
  /** Human-readable display name */
  readonly label: string;
  /** Emoji or icon URL for avatar position */
  readonly icon: string;
  /** Link to original source (e.g., PR URL) */
  readonly url?: string;
  /** Connector-specific metadata (e.g. presentation='system_notice', debugging, routing) */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** F134: Original sender info for group chat messages (message-level binding, not thread-level) */
  readonly sender?: { readonly id: string; readonly name?: string };
}

// ── Connector Definition (registry entry) ──

/** How a connector's avatar icon is rendered.
 *  - `svg`: maps to a React SVG component by `iconId` (see ConnectorIcon)
 *  - `png`: renders a PNG image from `src` path */
export type ConnectorIconSpec =
  | { readonly type: 'svg'; readonly iconId: string }
  | { readonly type: 'png'; readonly src: string };

/** Static definition of a connector type for frontend rendering.
 *  Every connector shares the same metadata shape: name + themeColor + icon.
 *  The OKLCH pipeline derives bubble/surface/ring colors from `themeColor`. */
export interface ConnectorDefinition {
  readonly id: string;
  /** Display name shown next to the message bubble. */
  readonly displayName: string;
  /** Avatar icon spec — single source of truth for icon rendering. */
  readonly icon: ConnectorIconSpec;
  /** Theme color hex — single source for OKLCH hue/chroma derivation + avatar ring.
   *  Avatar bg is computed via `tintedLight(themeColor, 0.5)`. */
  readonly themeColor: string;
  readonly description: string;
}

// ── Thread Binding (external platform ↔ Clowder AI thread) ──

/** Bidirectional mapping between an external chat and a Clowder AI thread. */
export interface ConnectorThreadBinding {
  readonly connectorId: string;
  readonly externalChatId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly createdAt: number;
  /** IM Hub thread for command isolation (ISSUE-8 Phase 8A). Lazily created on first IM command. */
  readonly hubThreadId?: string;
}

/** Target for outbound delivery after agent execution completes. */
export interface OutboundDeliveryTarget {
  readonly connectorId: string;
  readonly externalChatId: string;
  readonly metadata?: Record<string, unknown>;
}

// ── Connector Registry ──

const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = [
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

const connectorMap = new Map<string, ConnectorDefinition>(CONNECTOR_DEFINITIONS.map((d) => [d.id, d]));

/** Look up a connector definition by ID. */
export function getConnectorDefinition(connectorId: string): ConnectorDefinition | undefined {
  return connectorMap.get(connectorId);
}

/** Get all registered connector definitions. */
export function getAllConnectorDefinitions(): readonly ConnectorDefinition[] {
  return CONNECTOR_DEFINITIONS;
}
