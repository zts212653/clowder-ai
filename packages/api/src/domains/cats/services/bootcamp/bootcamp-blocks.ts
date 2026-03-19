/**
 * F087: Predefined Interactive Rich Block configurations for bootcamp phases.
 * These are used by the bootcamp-guide skill to present selection UIs.
 */

export interface BootcampInteractiveBlock {
  id: string;
  kind: 'interactive';
  v: 1;
  interactiveType: 'card-grid' | 'select' | 'confirm';
  title: string;
  description?: string;
  options: Array<{
    id: string;
    label: string;
    emoji?: string;
    icon?: string;
    description?: string;
    level?: number;
    group?: string;
  }>;
  allowRandom?: boolean;
  messageTemplate?: string;
}

/** Phase 0: Cat selection — user picks their lead guide cat */
export const catSelectionBlock: BootcampInteractiveBlock = {
  id: 'bootcamp-cat-select',
  kind: 'interactive',
  v: 1,
  interactiveType: 'card-grid',
  title: '选一只猫猫当你的主引导！',
  description: '其他猫猫也会在需要时登场帮忙',
  options: [
    {
      id: 'opus',
      icon: 'cat',
      label: '宪宪 (布偶猫)',
      description: '架构大师，深度思考',
      group: '选择你的引导猫',
    },
    {
      id: 'codex',
      icon: 'cat',
      label: '砚砚 (缅因猫)',
      description: '安全专家，严谨可靠',
      group: '选择你的引导猫',
    },
    {
      id: 'gemini',
      icon: 'cat',
      label: '烁烁 (暹罗猫)',
      description: '创意担当，视觉设计',
      group: '选择你的引导猫',
    },
  ],
  allowRandom: true,
  messageTemplate: '我选 {selection} 当我的引导猫！',
};

/** Phase 4: Task selection — user picks a bootcamp project */
export const taskSelectionBlock: BootcampInteractiveBlock = {
  id: 'bootcamp-task-select',
  kind: 'interactive',
  v: 1,
  interactiveType: 'card-grid',
  title: '选一个你感兴趣的项目，我们一起做！',
  description: '按难度分层，选适合你的，或者让命运来决定',
  allowRandom: true,
  options: [
    // Lv.1 — 好玩上手
    { id: 'Q1', icon: 'dice', label: '猫猫盲盒', description: '每日惊喜猫猫 ~30min', level: 1, group: 'Lv.1 好玩上手' },
    { id: 'Q2', icon: 'star', label: '猫猫星座', description: '三猫解运势 ~30min', level: 1, group: 'Lv.1 好玩上手' },
    {
      id: 'Q3',
      icon: 'search',
      label: '猫猫侦探社',
      description: '游戏化 debug ~1h',
      level: 1,
      group: 'Lv.1 好玩上手',
    },
    { id: 'Q4', icon: 'chat', label: '心情墙', description: '情绪价值拉满 ~1h', level: 1, group: 'Lv.1 好玩上手' },
    { id: 'Q5', icon: 'palette', label: 'Emoji 工坊', description: '跨猫创作 ~1h', level: 1, group: 'Lv.1 好玩上手' },
    { id: 'Q6', icon: 'coffee', label: '猫猫拿铁', description: '咖啡馆配方 ~1h', level: 1, group: 'Lv.1 好玩上手' },
    {
      id: 'Q7',
      icon: 'utensils',
      label: '猫猫点餐',
      description: '全栈点餐系统 ~2h',
      level: 1,
      group: 'Lv.1 好玩上手',
    },
    { id: 'Q8', icon: 'game', label: '像素猫猫', description: '像素互动场景 ~2h', level: 1, group: 'Lv.1 好玩上手' },
    { id: 'Q9', icon: 'chart', label: '3D 能力看板', description: '猫猫雷达图 ~2h', level: 1, group: 'Lv.1 好玩上手' },
    {
      id: 'Q10',
      icon: 'heart',
      label: '猫猫互动玩具',
      description: '逗猫棒+摸头 ~1h',
      level: 1,
      group: 'Lv.1 好玩上手',
    },
    // Lv.2 — 有深度
    { id: 'Q11', icon: 'sun', label: '猫猫天气站', description: 'API + 多猫播报 ~2h', level: 2, group: 'Lv.2 有深度' },
    { id: 'Q12', icon: 'test', label: 'Standup 面板', description: '协作可观测性 ~2h', level: 2, group: 'Lv.2 有深度' },
    { id: 'Q13', icon: 'trophy', label: '成就博物馆', description: 'Git 数据挖掘 ~3h', level: 2, group: 'Lv.2 有深度' },
    { id: 'Q14', icon: 'globe', label: '猫猫翻译官', description: '多风格翻译 ~2h', level: 2, group: 'Lv.2 有深度' },
    // Lv.3 — 进阶挑战
    { id: 'Q15', icon: 'scale', label: '决策室', description: '猫猫辩论赛 ~3h', level: 3, group: 'Lv.3 进阶挑战' },
    { id: 'Q16', icon: 'shuffle', label: '代码接力', description: '全流程协作 ~4h', level: 3, group: 'Lv.3 进阶挑战' },
  ],
  messageTemplate: '我选了 {selection}！',
};

/** Get all bootcamp block definitions by ID */
export const BOOTCAMP_BLOCKS: Record<string, BootcampInteractiveBlock> = {
  'bootcamp-cat-select': catSelectionBlock,
  'bootcamp-task-select': taskSelectionBlock,
};
