/**
 * Connector Types — 外部信息源抽象
 *
 * Connector 是从外部系统（GitHub、iMessage、Slack 等）
 * 进入 Cat Cafe 的消息来源。每个 connector 有固定的视觉标识
 * （icon、颜色），在前端以独立气泡样式展示。
 *
 * BACKLOG #97
 */

// ── Connector Source (附加到 StoredMessage) ──

/** Source metadata attached to messages from external connectors. */
export interface ConnectorSource {
  /** Stable connector identifier (used for routing + styling) */
  readonly connector: string;
  /** Human-readable display name */
  readonly label: string;
  /** Emoji or icon URL for avatar position */
  readonly icon: string;
  /** Link to original source (e.g., PR URL) */
  readonly url?: string;
  /** Connector-specific metadata (not rendered, for debugging/routing) */
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
      avatar: 'bg-slate-100 ring-2 ring-slate-200',
      label: 'text-slate-700',
      labelLink: 'text-slate-700 hover:text-slate-900',
      bubble: 'border border-slate-200 bg-slate-50',
    },
  },
  {
    id: 'github-ci',
    displayName: 'GitHub CI/CD',
    icon: 'github',
    color: { primary: '#2563EB', secondary: '#EFF6FF' },
    description: 'GitHub CI/CD 状态通知',
    tailwindTheme: {
      avatar: 'bg-slate-100 ring-2 ring-slate-200',
      label: 'text-slate-700',
      labelLink: 'text-slate-700 hover:text-slate-900',
      bubble: 'border border-slate-200 bg-slate-50',
    },
  },
  {
    id: 'github-conflict',
    displayName: 'PR Conflict',
    icon: 'github',
    color: { primary: '#D97706', secondary: '#FFFBEB' },
    description: 'GitHub PR 冲突状态通知',
    tailwindTheme: {
      avatar: 'bg-amber-100 ring-2 ring-amber-200',
      label: 'text-amber-700',
      labelLink: 'text-amber-700 hover:text-amber-900',
      bubble: 'border border-amber-200 bg-amber-50',
    },
  },
  {
    id: 'github-review-feedback',
    displayName: 'Review Feedback',
    icon: 'github',
    color: { primary: '#475569', secondary: '#F8FAFC' },
    description: 'GitHub PR review feedback 通知',
    tailwindTheme: {
      avatar: 'bg-slate-100 ring-2 ring-slate-200',
      label: 'text-slate-700',
      labelLink: 'text-slate-700 hover:text-slate-900',
      bubble: 'border border-slate-200 bg-slate-50',
    },
  },
  {
    id: 'github-repo-event',
    displayName: 'Repo Inbox',
    icon: 'github',
    color: { primary: '#24292e', secondary: '#F6F8FA' },
    description: 'GitHub 仓库事件通知（新 PR / 新 Issue）',
    tailwindTheme: {
      avatar: 'bg-gray-100 ring-2 ring-gray-300',
      label: 'text-gray-800',
      labelLink: 'text-gray-800 hover:text-black',
      bubble: 'border border-gray-300 bg-gray-50',
    },
  },
  {
    id: 'vote-result',
    displayName: '投票结果',
    icon: 'ballot',
    color: { primary: '#7C3AED', secondary: '#F5F3FF' },
    description: '投票系统自动汇总结果',
    tailwindTheme: {
      avatar: 'bg-purple-100 ring-2 ring-purple-200',
      label: 'text-purple-700',
      labelLink: 'text-purple-700 hover:text-purple-900',
      bubble: 'border border-purple-200 bg-purple-50',
    },
  },
  {
    id: 'multi-mention-result',
    displayName: 'Multi-Mention 结果',
    icon: 'users',
    color: { primary: '#059669', secondary: '#ECFDF5' },
    description: '多猫 @mention 聚合结果',
    tailwindTheme: {
      avatar: 'bg-emerald-100 ring-2 ring-emerald-200',
      label: 'text-emerald-700',
      labelLink: 'text-emerald-700 hover:text-emerald-900',
      bubble: 'border border-emerald-200 bg-emerald-50',
    },
  },
  {
    id: 'feishu',
    displayName: '飞书',
    icon: '/images/connectors/feishu.png',
    color: { primary: '#3370FF', secondary: '#E8F0FE' },
    description: '飞书机器人',
    tailwindTheme: {
      avatar: 'bg-blue-100 ring-2 ring-blue-200',
      label: 'text-blue-700',
      labelLink: 'text-blue-700 hover:text-blue-900',
      bubble: 'border border-blue-200 bg-blue-50',
    },
  },
  {
    id: 'telegram',
    displayName: 'Telegram',
    icon: '/images/connectors/telegram.png',
    color: { primary: '#0088CC', secondary: '#E3F2FD' },
    description: 'Telegram Bot',
    tailwindTheme: {
      avatar: 'bg-sky-100 ring-2 ring-sky-200',
      label: 'text-sky-700',
      labelLink: 'text-sky-700 hover:text-sky-900',
      bubble: 'border border-sky-200 bg-sky-50',
    },
  },
  {
    id: 'dingtalk',
    displayName: '钉钉',
    icon: '/images/connectors/dingtalk.png',
    color: { primary: '#3296FA', secondary: '#E8F4FE' },
    description: '钉钉企业内部应用',
    tailwindTheme: {
      avatar: 'bg-cyan-100 ring-2 ring-cyan-200',
      label: 'text-cyan-700',
      labelLink: 'text-cyan-700 hover:text-cyan-900',
      bubble: 'border border-cyan-200 bg-cyan-50',
    },
  },
  {
    id: 'xiaoyi',
    displayName: '小艺 APP',
    icon: '/images/connectors/xiaoyi.png',
    color: { primary: '#CF0A2C', secondary: '#FFF0F0' },
    description: '华为小艺 OpenClaw 模式',
    tailwindTheme: {
      avatar: 'bg-red-100 ring-2 ring-red-200',
      label: 'text-red-700',
      labelLink: 'text-red-700 hover:text-red-900',
      bubble: 'border border-red-200 bg-red-50',
    },
  },
  {
    id: 'wecom-bot',
    displayName: '企业微信',
    icon: '/images/connectors/wecom-bot.png',
    color: { primary: '#4F46E5', secondary: '#EEF2FF' },
    description: '企业微信智能机器人 (WebSocket)',
    tailwindTheme: {
      avatar: 'bg-indigo-100 ring-2 ring-indigo-200',
      label: 'text-indigo-700',
      labelLink: 'text-indigo-700 hover:text-indigo-900',
      bubble: 'border border-indigo-200 bg-indigo-50',
    },
  },
  {
    id: 'wecom-agent',
    displayName: '企微自建应用',
    icon: '/images/connectors/wecom-agent.png',
    color: { primary: '#7C3AED', secondary: '#F5F3FF' },
    description: '企业微信自建应用 (HTTP 回调)',
    tailwindTheme: {
      avatar: 'bg-violet-100 ring-2 ring-violet-200',
      label: 'text-violet-700',
      labelLink: 'text-violet-700 hover:text-violet-900',
      bubble: 'border border-violet-200 bg-violet-50',
    },
  },
  {
    id: 'weixin',
    displayName: '微信',
    icon: '/images/connectors/weixin.png',
    color: { primary: '#07C160', secondary: '#E8F8EE' },
    description: '微信个人号 iLink Bot',
    tailwindTheme: {
      avatar: 'bg-green-100 ring-2 ring-green-200',
      label: 'text-green-700',
      labelLink: 'text-green-700 hover:text-green-900',
      bubble: 'border border-green-200 bg-green-50',
    },
  },
  {
    id: 'scheduler',
    displayName: '定时任务',
    icon: 'scheduler',
    color: { primary: '#F59E0B', secondary: '#FFFBEB' },
    description: '定时任务投递',
    tailwindTheme: {
      avatar: 'bg-amber-100 ring-2 ring-amber-200',
      label: 'text-amber-700',
      labelLink: 'text-amber-700 hover:text-amber-900',
      bubble: 'border border-amber-200 bg-amber-50',
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
