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

/** Tailwind CSS class strings for connector bubble styling. */
export interface ConnectorTailwindTheme {
  readonly avatar: string;
  readonly label: string;
  readonly labelLink: string;
  readonly bubble: string;
}

/** Static definition of a connector type for frontend rendering. */
export interface ConnectorDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly icon: string;
  readonly color: {
    /** Primary accent color (border, label) */
    readonly primary: string;
    /** Secondary background color (bubble fill) */
    readonly secondary: string;
  };
  readonly description: string;
  /** Tailwind theme for ConnectorBubble rendering. If omitted, default theme is used. */
  readonly tailwindTheme?: ConnectorTailwindTheme;
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
  {
    id: 'github-review',
    displayName: 'GitHub Review',
    icon: 'github',
    color: { primary: '#2563EB', secondary: '#EFF6FF' },
    description: 'GitHub PR review 邮件通知',
    tailwindTheme: {
      avatar: 'bg-conn-slate-bg ring-2 ring-conn-slate-ring',
      label: 'text-conn-slate-text',
      labelLink: 'text-conn-slate-text hover:text-conn-slate-hover',
      bubble: 'border border-conn-slate-bubble-border bg-conn-slate-bubble-bg',
    },
  },
  {
    id: 'github-ci',
    displayName: 'GitHub CI/CD',
    icon: 'github',
    color: { primary: '#2563EB', secondary: '#EFF6FF' },
    description: 'GitHub CI/CD 状态通知',
    tailwindTheme: {
      avatar: 'bg-conn-slate-bg ring-2 ring-conn-slate-ring',
      label: 'text-conn-slate-text',
      labelLink: 'text-conn-slate-text hover:text-conn-slate-hover',
      bubble: 'border border-conn-slate-bubble-border bg-conn-slate-bubble-bg',
    },
  },
  {
    id: 'github-conflict',
    displayName: 'PR Conflict',
    icon: 'github',
    color: { primary: '#D97706', secondary: '#FFFBEB' },
    description: 'GitHub PR 冲突状态通知',
    tailwindTheme: {
      avatar: 'bg-conn-amber-bg ring-2 ring-conn-amber-ring',
      label: 'text-conn-amber-text',
      labelLink: 'text-conn-amber-text hover:text-conn-amber-hover',
      bubble: 'border border-conn-amber-bubble-border bg-conn-amber-bubble-bg',
    },
  },
  {
    id: 'github-review-feedback',
    displayName: 'Review Feedback',
    icon: 'github',
    color: { primary: '#475569', secondary: '#F8FAFC' },
    description: 'GitHub PR review feedback 通知',
    tailwindTheme: {
      avatar: 'bg-conn-slate-bg ring-2 ring-conn-slate-ring',
      label: 'text-conn-slate-text',
      labelLink: 'text-conn-slate-text hover:text-conn-slate-hover',
      bubble: 'border border-conn-slate-bubble-border bg-conn-slate-bubble-bg',
    },
  },
  {
    id: 'github-repo-event',
    displayName: 'Repo Inbox',
    icon: 'github',
    color: { primary: '#24292e', secondary: '#F6F8FA' },
    description: 'GitHub 仓库事件通知（新 PR / 新 Issue）',
    tailwindTheme: {
      avatar: 'bg-conn-gray-bg ring-2 ring-conn-gray-ring',
      label: 'text-conn-gray-text',
      labelLink: 'text-conn-gray-text hover:text-conn-gray-hover',
      bubble: 'border border-conn-gray-bubble-border bg-conn-gray-bubble-bg',
    },
  },
  {
    id: 'vote-result',
    displayName: '投票结果',
    icon: 'ballot',
    color: { primary: '#7C3AED', secondary: '#F5F3FF' },
    description: '投票系统自动汇总结果',
    tailwindTheme: {
      avatar: 'bg-conn-purple-bg ring-2 ring-conn-purple-ring',
      label: 'text-conn-purple-text',
      labelLink: 'text-conn-purple-text hover:text-conn-purple-hover',
      bubble: 'border border-conn-purple-bubble-border bg-conn-purple-bubble-bg',
    },
  },
  {
    id: 'multi-mention-result',
    displayName: 'Multi-Mention 结果',
    icon: 'users',
    color: { primary: '#059669', secondary: '#ECFDF5' },
    description: '多猫 @mention 聚合结果',
    tailwindTheme: {
      avatar: 'bg-conn-emerald-bg ring-2 ring-conn-emerald-ring',
      label: 'text-conn-emerald-text',
      labelLink: 'text-conn-emerald-text hover:text-conn-emerald-hover',
      bubble: 'border border-conn-emerald-bubble-border bg-conn-emerald-bubble-bg',
    },
  },
  {
    id: 'feishu',
    displayName: '飞书',
    icon: '/images/connectors/feishu.png',
    color: { primary: '#3370FF', secondary: '#E8F0FE' },
    description: '飞书机器人',
    tailwindTheme: {
      avatar: 'bg-conn-blue-bg ring-2 ring-conn-blue-ring',
      label: 'text-conn-blue-text',
      labelLink: 'text-conn-blue-text hover:text-conn-blue-hover',
      bubble: 'border border-conn-blue-bubble-border bg-conn-blue-bubble-bg',
    },
  },
  {
    id: 'telegram',
    displayName: 'Telegram',
    icon: '/images/connectors/telegram.png',
    color: { primary: '#0088CC', secondary: '#E3F2FD' },
    description: 'Telegram Bot',
    tailwindTheme: {
      avatar: 'bg-conn-sky-bg ring-2 ring-conn-sky-ring',
      label: 'text-conn-sky-text',
      labelLink: 'text-conn-sky-text hover:text-conn-sky-hover',
      bubble: 'border border-conn-sky-bubble-border bg-conn-sky-bubble-bg',
    },
  },
  {
    id: 'dingtalk',
    displayName: '钉钉',
    icon: '/images/connectors/dingtalk.png',
    color: { primary: '#3296FA', secondary: '#E8F4FE' },
    description: '钉钉企业内部应用',
    tailwindTheme: {
      avatar: 'bg-conn-cyan-bg ring-2 ring-conn-cyan-ring',
      label: 'text-conn-cyan-text',
      labelLink: 'text-conn-cyan-text hover:text-conn-cyan-hover',
      bubble: 'border border-conn-cyan-bubble-border bg-conn-cyan-bubble-bg',
    },
  },
  {
    id: 'xiaoyi',
    displayName: '小艺 APP',
    icon: '/images/connectors/xiaoyi.png',
    color: { primary: '#CF0A2C', secondary: '#FFF0F0' },
    description: '华为小艺 OpenClaw 模式',
    tailwindTheme: {
      avatar: 'bg-conn-red-bg ring-2 ring-conn-red-ring',
      label: 'text-conn-red-text',
      labelLink: 'text-conn-red-text hover:text-conn-red-hover',
      bubble: 'border border-conn-red-bubble-border bg-conn-red-bubble-bg',
    },
  },
  {
    id: 'wecom-bot',
    displayName: '企业微信',
    icon: '/images/connectors/wecom-bot.png',
    color: { primary: '#4F46E5', secondary: '#EEF2FF' },
    description: '企业微信智能机器人 (WebSocket)',
    tailwindTheme: {
      avatar: 'bg-conn-indigo-bg ring-2 ring-conn-indigo-ring',
      label: 'text-conn-indigo-text',
      labelLink: 'text-conn-indigo-text hover:text-conn-indigo-hover',
      bubble: 'border border-conn-indigo-bubble-border bg-conn-indigo-bubble-bg',
    },
  },
  {
    id: 'wecom-agent',
    displayName: '企微自建应用',
    icon: '/images/connectors/wecom-agent.png',
    color: { primary: '#7C3AED', secondary: '#F5F3FF' },
    description: '企业微信自建应用 (HTTP 回调)',
    tailwindTheme: {
      avatar: 'bg-conn-violet-bg ring-2 ring-conn-violet-ring',
      label: 'text-conn-violet-text',
      labelLink: 'text-conn-violet-text hover:text-conn-violet-hover',
      bubble: 'border border-conn-violet-bubble-border bg-conn-violet-bubble-bg',
    },
  },
  {
    id: 'weixin',
    displayName: '微信',
    icon: '/images/connectors/weixin.png',
    color: { primary: '#07C160', secondary: '#E8F8EE' },
    description: '微信个人号 iLink Bot',
    tailwindTheme: {
      avatar: 'bg-conn-green-bg ring-2 ring-conn-green-ring',
      label: 'text-conn-green-text',
      labelLink: 'text-conn-green-text hover:text-conn-green-hover',
      bubble: 'border border-conn-green-bubble-border bg-conn-green-bubble-bg',
    },
  },
  {
    id: 'scheduler',
    displayName: '定时任务',
    icon: 'scheduler',
    color: { primary: '#F59E0B', secondary: '#FFFBEB' },
    description: '定时任务投递',
    tailwindTheme: {
      avatar: 'bg-conn-amber-bg ring-2 ring-conn-amber-ring',
      label: 'text-conn-amber-text',
      labelLink: 'text-conn-amber-text hover:text-conn-amber-hover',
      bubble: 'border border-conn-amber-bubble-border bg-conn-amber-bubble-bg',
    },
  },
  {
    id: 'system-command',
    displayName: 'Clowder AI',
    icon: 'settings',
    color: { primary: '#6B7280', secondary: '#F9FAFB' },
    description: '系统命令响应',
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
