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
