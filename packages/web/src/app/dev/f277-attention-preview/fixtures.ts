import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';

export interface F277PreviewThread extends SidebarSnapshotRow {
  readonly previewMessageId: string;
  readonly previewMessage: string;
}

export interface F277PreviewCluster {
  readonly id: string;
  readonly exactAnchor: string;
  readonly canonicalTitle: string;
  readonly sourceHref: string;
  readonly updatedLabel: string;
  readonly members: readonly F277PreviewThread[];
}

const HOUR = 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 7, 23, 9, 0, 0);

function thread(
  id: string,
  title: string,
  ageHours: number,
  options: Partial<SidebarSnapshotRow> & Pick<F277PreviewThread, 'previewMessage'>,
): F277PreviewThread {
  return {
    id,
    title,
    participants: options.participants ?? ['codex', 'opus'],
    pinned: options.pinned ?? false,
    favorited: options.favorited ?? false,
    labels: options.labels ?? [],
    preferredCats: options.preferredCats ?? [],
    projectPath: options.projectPath ?? '/home/user/cat-cafe',
    lastActiveAt: NOW - ageHours * HOUR,
    systemKind: options.systemKind ?? null,
    isHubThread: options.isHubThread ?? false,
    unreadCount: options.unreadCount ?? 0,
    hasUserMention: options.hasUserMention ?? false,
    presence: options.presence ?? { status: 'idle' },
    previewMessageId: `message_f277_preview_${id === 'thread_mqolv53prjb760ye' ? '1' : id.slice(-4)}`,
    previewMessage: options.previewMessage,
  };
}

export const F277_PREVIEW_CLUSTERS: readonly F277PreviewCluster[] = [
  {
    id: 'f296',
    exactAnchor: 'F296',
    canonicalTitle: 'Continuity-Aware Context Injection — 冷启动可信定向包 + 热续增量',
    sourceHref: '/workspace/docs/features/F296-continuity-aware-context-injection.md',
    updatedLabel: '2 时',
    members: [
      thread('thread_mt4h0nb4zobodv6x', 'P1 F296 B4c：Alpha 五旅程 UAT 与证据收口', 2, {
        pinned: true,
        presence: { status: 'done', cats: ['codex'] },
        previewMessage: 'Alpha 五旅程已收口，证据按 exact anchor 回填到验收记录。',
      }),
      thread(
        'thread_mt15zbnmn9d62oen',
        'P1 F296 Phase B4：app_server continuity、telemetry、ledger reaper 与 Alpha 五旅程',
        14,
        {
          pinned: true,
          participants: ['codex', 'opus', 'gpt52'],
          previewMessage: 'continuity telemetry 已接入，下一步核对 ledger reaper 的退休边界。',
        },
      ),
      thread(
        'thread_mqolv53prjb760ye',
        'F296 F148 P1 bugfix: recentFilesTouched 死代码路径 → 活跃 session 文件产物不可见',
        17,
        {
          pinned: true,
          participants: ['codex', 'opus', 'gpt52', 'gemini'],
          presence: { status: 'working', cats: ['codex'], activeSince: NOW - 35 * 60_000 },
          unreadCount: 2,
          hasUserMention: true,
          previewMessage: 'recentFilesTouched 的死代码路径已经复现；当前正在验证活跃 session 的文件产物召回。',
        },
      ),
      thread('thread_mt44ruccbr05lv3n', 'P1 F296 B4b：carrier-neutral continuity telemetry', 17, {
        previewMessage: '载体中立的 continuity 事件已冻结，不依赖某一个聊天 runtime。',
      }),
      thread('thread_mt3uyvksdc2djqpo', 'P1 F296 B4a：app_server continuity 与 epoch-fenced retirement', 19, {
        participants: ['codex', 'opus'],
        previewMessage: 'epoch fence 只约束退休时序，不改变用户可见的 thread 身份。',
      }),
      thread('thread_mszqscbpr2jxdoei', 'P1 F296 Phase B3：关闭四道 ledger 硬门并收敛全部 prompt surface', 72, {
        presence: { status: 'done', cats: ['opus'] },
        previewMessage: '四道 ledger 门已关闭，prompt surface 收敛到同一投影。',
      }),
      thread('thread_msx7j1x4y2jbxlp9', 'P1 F296 施工：Phase A 收口 → B1 epoch → B2 mapper/ledger', 120, {
        participants: ['codex', 'opus', 'owner'],
        previewMessage: 'Phase A 到 B2 的施工脉络保留在原 thread，可从这里回跳。',
      }),
    ],
  },
  {
    id: 'f277',
    exactAnchor: 'F277',
    canonicalTitle: 'Thread Attention Navigation',
    sourceHref: '/workspace/docs/features/F277-thread-attention-navigation.md',
    updatedLabel: '26 分',
    members: [
      thread('thread_mslbd9ghs8rdoxui', 'F277 视觉裁决：真实 Sidebar 聚类、折叠与命名', 0.4, {
        pinned: true,
        participants: ['codex', 'opus', 'owner'],
        hasUserMention: true,
        unreadCount: 1,
        presence: { status: 'working', cats: ['codex'], activeSince: NOW - 18 * 60_000 },
        previewMessage: '这一轮只裁决真实 Sidebar 里的注意力压缩，不把内部 ontology 暴露给用户。',
      }),
      thread('thread_ms1j7vfalrt37olz', 'F277 thread-graph 与前端 UX 设计重构', 12, {
        pinned: true,
        previewMessage: '关系 membership 只来自 exact ref，标题和邻近关系都不能猜。',
      }),
      thread('thread_f277_dual_chat', 'F277 双 Chat 阅读与可逆让位', 31, {
        previewMessage: '第二 Chat 保留全文、草稿与滚动位置，关闭后把空间还给 Workspace。',
      }),
      thread('thread_f277_search_recall', 'F277 搜索召回与折叠偏好', 48, {
        previewMessage: '折叠只减少扫视单位；搜索命中时必须展开并高亮原成员。',
      }),
    ],
  },
  {
    id: 'f297',
    exactAnchor: 'F297',
    canonicalTitle: 'Canonical Sidebar Projection',
    sourceHref: '/workspace/docs/features/F297-sidebar-projection-convergence.md',
    updatedLabel: '3 时',
    members: [
      thread('thread_f297_snapshot', 'F297 SidebarSnapshotRow 权威投影', 3, {
        pinned: true,
        presence: { status: 'done', cats: ['opus'] },
        previewMessage: 'SidebarSnapshotRow 是参与者、运行状态、未读与时间的唯一前端读模型。',
      }),
      thread('thread_f297_realtime', 'Sidebar realtime projection bugfix', 5, {
        presence: { status: 'done', cats: ['codex'] },
        previewMessage: 'thread_updated 已复用既有 user-room，不新增平行 event 或 store。',
      }),
      thread('thread_f297_duration', 'F297 working duration：activeSince 语义门', 9, {
        previewMessage: 'working duration 只来自 activeSince，不能用 lastActiveAt 冒充。',
      }),
    ],
  },
];

export const F277_INITIAL_THREAD_ID = 'thread_mslbd9ghs8rdoxui';

/** Existing explicit Groups for the interactive fixture; the default product list never derives these from relations. */
export const F277_PREVIEW_GROUPS: readonly ThreadAttentionGroup[] = F277_PREVIEW_CLUSTERS.filter(
  (cluster) => cluster.id !== 'f297',
).map((cluster) => ({
  id: `attention_preview_${cluster.id}`,
  name: `${cluster.exactAnchor} · ${cluster.canonicalTitle}`,
  threadIds: cluster.members.map((member) => member.id),
}));

export function previewClusterMatches(cluster: F277PreviewCluster, displayTitle: string, query: string): boolean {
  return [
    cluster.exactAnchor,
    cluster.canonicalTitle,
    displayTitle,
    ...cluster.members.flatMap((member) => [member.id, member.title ?? '']),
  ]
    .join(' ')
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}
