export const DEMO_TEAM = {
  architect: { name: '布偶猫', role: '架构师 · 负责交付', avatar: '/avatars/opus.png' },
  designer: { name: '暹罗猫', role: '设计师 · 负责体验', avatar: '/avatars/gemini.png' },
  developer: { name: '缅因猫', role: '开发者 · 负责实现', avatar: '/avatars/codex.png' },
} as const;

export type DemoCat = keyof typeof DEMO_TEAM;
export type DemoArtifact = 'design' | 'architecture' | 'initial' | 'review' | 'final';
export type DemoPreviewStage = DemoArtifact | 'waiting';
export interface DemoEvent {
  id: string;
  title: string;
  speaker: DemoCat | 'user' | 'system';
  text: string;
  duration: number;
  to?: DemoCat;
  artifact?: DemoArtifact;
}

export const DEMO_EVENTS: readonly DemoEvent[] = [
  {
    id: 'team',
    title: '演示团队已就位',
    speaker: 'system',
    duration: 2600,
    text: '已为这次演示准备三位伙伴。这里使用预置数据，不会检测本机工具，也不会调用模型。',
  },
  {
    id: 'task',
    title: '发布一个小目标',
    speaker: 'user',
    duration: 3500,
    text: '@布偶猫 帮我做一个简单的“今天待办”网页。清楚、好看，能添加和完成任务。请和伙伴一起做好，最后给我一个能打开使用的页面。',
  },
  {
    id: 'accept',
    title: '接单与拆解',
    speaker: 'architect',
    duration: 5000,
    to: 'designer',
    text: '收到，我负责最终交付。先确定体验，再实现，最后由我审查。@暹罗猫 请设计任务列表、添加入口和完成状态，做好后交回给我。',
  },
  {
    id: 'design',
    title: '设计方案已交回',
    speaker: 'designer',
    duration: 5000,
    to: 'architect',
    artifact: 'design',
    text: '用一张清爽的每日清单：上方添加，下方勾选；保留“全部 / 未完成 / 已完成”筛选。列表为空时也要解释当前状态。@布偶猫 请整合方案。',
  },
  {
    id: 'architecture',
    title: '整合方案，交给开发',
    speaker: 'architect',
    duration: 5000,
    to: 'developer',
    artifact: 'architecture',
    text: '采纳这个设计。用一个无需登录的网页实现，每项任务使用独立 ID，添加时去掉首尾空格。@缅因猫 请实现添加、完成和筛选，交回后我来检查。',
  },
  {
    id: 'build',
    title: '第一版实现已交回',
    speaker: 'developer',
    duration: 4000,
    to: 'architect',
    artifact: 'initial',
    text: '第一版已完成：可以添加、勾选和筛选任务。@布偶猫 请检查交互和边界情况。',
  },
  {
    id: 'review',
    title: '审查发现两个问题',
    speaker: 'architect',
    duration: 5500,
    to: 'developer',
    artifact: 'review',
    text: '主要流程可用，但未完成任务全部勾选后变成空白；提交空格也没有反馈。@缅因猫 请补上“今天的任务都完成了”和“先写下一件小事”的提示。',
  },
  {
    id: 'revision',
    title: '已修正，交回复核',
    speaker: 'developer',
    duration: 5000,
    to: 'architect',
    artifact: 'final',
    text: '已修正：完成所有任务时显示鼓励提示，空白输入会提示补充内容。保留用户当前的筛选条件。@布偶猫 请复核这两个场景。',
  },
  {
    id: 'approved',
    title: '审查通过，交付成果',
    speaker: 'architect',
    duration: 3000,
    artifact: 'final',
    text: '审查通过，两个问题都已修正。右侧的“今天待办”就是我们一起完成的成果，你可以亲自添加任务、勾选完成和切换筛选。接下来，创建你自己的猫猫团队吧。',
  },
];

// Navigation must inherit the user's presentation preference, never write a shell intent.
export const DEMO_SETTINGS_URL = '/settings?s=members&view=setup';
