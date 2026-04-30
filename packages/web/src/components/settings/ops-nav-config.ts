export interface OpsSubsection {
  id: string;
  label: string;
}

export const OPS_SUBSECTIONS: OpsSubsection[] = [
  { id: 'usage', label: '使用统计' },
  { id: 'leaderboard', label: '排行榜' },
  { id: 'memory', label: '记忆索引' },
  { id: 'health', label: '系统健康' },
  { id: 'commands', label: '命令速查' },
  { id: 'rescue', label: '紧急救援' },
];

export const DEFAULT_OPS_SUBSECTION = 'usage';
