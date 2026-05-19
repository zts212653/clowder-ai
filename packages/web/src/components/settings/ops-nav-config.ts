export interface OpsSubsection {
  id: string;
  label: string;
}

export const OPS_SUBSECTIONS: OpsSubsection[] = [
  { id: 'usage', label: '使用统计' },
  { id: 'leaderboard', label: '排行榜' },
  { id: 'observability', label: '监控面板' },
  { id: 'agent-sessions', label: '后台会话' },
  { id: 'health', label: '治理与刹车' },
  { id: 'commands', label: '命令速查' },
  { id: 'rescue', label: '紧急救援' },
];

export const DEFAULT_OPS_SUBSECTION = 'usage';
