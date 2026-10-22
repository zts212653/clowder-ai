import type { CatId } from '@cat-cafe/shared';
import type { TeamHomeData } from './types';

const now = new Date().toISOString();

export const teamHomeFixture: TeamHomeData = {
  mission: {
    text: '让每个有想法的人，都能带着一支 Agent 原生团队，把想法做成能运行的世界。',
    phase: 'impl',
    activeFeatureId: '—',
    truthSourceUrl: undefined,
  },
  baton: {
    holder: 'co-creator',
    scope: '当前无明确持球任务',
    since: now,
    nextStep: '等待新的 mission 被领取或分配',
    nextOwner: undefined,
    blocker: null,
  },
  qualityGates: [],
  team: [
    {
      id: 'codex' as CatId,
      name: 'Codex',
      role: 'agent',
      currentContext: '等待任务',
      lastActiveAt: now,
      capabilities: ['spec', 'review', 'architecture'],
    },
    {
      id: 'kiimi' as CatId,
      name: 'KK',
      role: 'agent',
      currentContext: '等待任务',
      lastActiveAt: now,
      capabilities: ['impl', 'tdd', 'frontend'],
    },
    {
      id: 'claude' as CatId,
      name: 'Claude',
      role: 'agent',
      currentContext: '等待任务',
      lastActiveAt: now,
      capabilities: ['design', 'frontend', 'ux'],
    },
    {
      id: 'co-creator',
      name: '铲屎官',
      role: 'human',
      currentContext: '愿景守护 / CVO 决策',
      lastActiveAt: now,
      capabilities: ['cvo_decision', 'vision_guard'],
    },
  ],
  missions: [],
  culture: {
    headline: '方向正确 > 执行速度',
    rules: [
      { id: 'p1', text: '面向终态，不绕路', active: true },
      { id: 'state', text: '状态高于消息', active: true },
      { id: 'root_cause', text: '根因大于补丁', active: false },
      { id: 'evidence', text: '可验证才算完成', active: true },
    ],
  },
  cvoDecisions: [],
  risks: [],
  recentMemory: [],
};
