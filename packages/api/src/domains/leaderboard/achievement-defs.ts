/**
 * F075 Phase C — Achievement badge definitions
 * Static catalog of all unlockable achievements (CVO + daily).
 */
import type { Achievement } from '@cat-cafe/shared';

type AchievementDef = Omit<Achievement, 'unlockedAt'>;

/** CVO (Cat Virtual Officer) progression badges */
const CVO_ACHIEVEMENTS: AchievementDef[] = [
  { id: 'cvo-first-review', icon: 'search', label: '初审官', description: '完成第一次 code review', category: 'cvo' },
  { id: 'cvo-5-reviews', icon: 'test', label: '审计达人', description: '完成 5 次 code review', category: 'cvo' },
  {
    id: 'cvo-first-merge',
    icon: 'shuffle',
    label: '合入初体验',
    description: '第一个 PR 被合入 main',
    category: 'cvo',
  },
  { id: 'cvo-10-commits', icon: 'code', label: '码力全开', description: '累计 10 次 commit', category: 'cvo' },
  { id: 'cvo-bug-hunter', icon: 'bug', label: '捉虫猎手', description: '修复 3 个 bug', category: 'cvo' },
  {
    id: 'cvo-architect',
    icon: 'architecture',
    label: '架构师',
    description: '主导一个 feature 从立项到合入',
    category: 'cvo',
  },
  { id: 'cvo-mentor', icon: 'graduation', label: '带教官', description: '帮助其他猫完成第一个 PR', category: 'cvo' },
];

/** Bootcamp CVO progression badges (F087 Phase D) */
const BOOTCAMP_ACHIEVEMENTS: AchievementDef[] = [
  { id: 'bootcamp-enrolled', icon: 'backpack', label: '入营新兵', description: '开始猫猫训练营', category: 'cvo' },
  { id: 'bootcamp-env-ready', icon: 'tool', label: '装备齐全', description: '通过环境检测', category: 'cvo' },
  {
    id: 'bootcamp-first-decision',
    icon: 'target',
    label: '第一次拍板',
    description: '做出第一个 CVO 决策',
    category: 'cvo',
  },
  {
    id: 'bootcamp-graduated',
    icon: 'graduation',
    label: '训练营毕业',
    description: '完成猫猫训练营全流程',
    category: 'cvo',
  },
];

/** Daily fun badges */
const DAILY_ACHIEVEMENTS: AchievementDef[] = [
  { id: 'daily-night-owl', icon: 'moon', label: '夜猫子', description: '凌晨 2-5 点还在写代码', category: 'daily' },
  { id: 'daily-streak-7', icon: 'flame', label: '七日连勤', description: '连续 7 天活跃', category: 'daily' },
  { id: 'daily-streak-30', icon: 'bolt', label: '月度铁人', description: '连续 30 天活跃', category: 'daily' },
  { id: 'daily-chatty', icon: 'chat', label: '话痨猫猫', description: '单日消息超过 50 条', category: 'daily' },
  { id: 'daily-game-mvp', icon: 'trophy', label: '游戏 MVP', description: '在猫猫杀中获得 MVP', category: 'daily' },
  {
    id: 'daily-shame-king',
    icon: 'cross',
    label: '社死之王',
    description: '在谁是卧底中被投出 3 次',
    category: 'daily',
  },
];

export const ALL_ACHIEVEMENTS: ReadonlyMap<string, AchievementDef> = new Map(
  [...CVO_ACHIEVEMENTS, ...BOOTCAMP_ACHIEVEMENTS, ...DAILY_ACHIEVEMENTS].map((a) => [a.id, a]),
);

/** CVO level thresholds */
const CVO_LEVELS = [
  { level: 1, title: '实习猫猫', description: '刚入职的小猫', threshold: 0 },
  { level: 2, title: '正式员工', description: '能独立完成任务', threshold: 2 },
  { level: 3, title: '高级工程猫', description: '技术骨干', threshold: 4 },
  { level: 4, title: '技术专家猫', description: '架构级能力', threshold: 6 },
  { level: 5, title: '首席铲码官', description: 'CVO — Chief Vibe Officer', threshold: 7 },
] as const;

/**
 * Maps bootcamp phase transitions to achievement IDs.
 * Used by callback-bootcamp-routes to auto-emit achievements.
 */
export const BOOTCAMP_PHASE_ACHIEVEMENTS: ReadonlyMap<string, string> = new Map([
  ['phase-1-intro', 'bootcamp-enrolled'],
  ['phase-4-task-select', 'bootcamp-env-ready'],
  ['phase-5-kickoff', 'bootcamp-first-decision'],
  ['phase-11-farewell', 'bootcamp-graduated'],
]);

export function computeCvoLevel(cvoUnlockedCount: number) {
  let current: (typeof CVO_LEVELS)[number] = CVO_LEVELS[0]!;
  for (const lvl of CVO_LEVELS) {
    if (cvoUnlockedCount >= lvl.threshold) current = lvl;
    else break;
  }
  const nextIdx = CVO_LEVELS.findIndex((l) => l.level === current.level) + 1;
  const next = nextIdx < CVO_LEVELS.length ? CVO_LEVELS[nextIdx] : undefined;

  return {
    level: current.level,
    title: current.title,
    description: current.description,
    progress: next ? cvoUnlockedCount / next.threshold : 1,
    ...(next ? { nextTitle: next.title, needed: next.threshold - cvoUnlockedCount } : {}),
  };
}
