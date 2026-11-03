export const sampleThreads = [
  { id: 'release', title: '版本发布准备', note: '发布说明、演示材料与验收安排' },
  { id: 'export', title: '导出问题排查', note: '复现、修复与审查反馈' },
  { id: 'ideas', title: '下周的一些想法', note: '仍在讨论，暂未决定要做' },
];

export const previewRows = sampleThreads.map((thread, index) => ({
  id: `preview-${thread.id}`,
  title: thread.title,
  participants: [],
  pinned: false,
  favorited: false,
  labels: [],
  preferredCats: [],
  projectPath: 'Superagent 体验样例',
  lastActiveAt: Date.UTC(2026, 10, 3, 10, 30 - index),
  systemKind: null,
  isHubThread: false,
  unreadCount: 0,
  hasUserMention: false,
  presence: { status: 'idle' as const },
}));
