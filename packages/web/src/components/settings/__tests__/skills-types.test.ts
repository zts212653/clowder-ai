import { describe, expect, it } from 'vitest';
import type { CapabilityBoardItem } from '../../capability-board-ui';
import { composeSkillItems, matchesSkillSearch, type SettingsSkillItem, type SkillsData } from '../skills-types';

function makeSkillItem(overrides: Partial<SettingsSkillItem> = {}): SettingsSkillItem {
  return {
    id: 'test-skill',
    name: 'test-skill',
    category: '工具',
    trigger: '/test',
    governance: {
      mounts: { claude: true, codex: true, gemini: false, kimi: false },
      mountedCount: 2,
      requiresMcp: [],
      hasConflict: false,
      isStaleNew: false,
      isStaleRemoved: false,
    },
    controls: null,
    ...overrides,
  };
}

describe('matchesSkillSearch', () => {
  it('matches by name', () => {
    const skill = makeSkillItem({ name: 'merge-gate' });
    expect(matchesSkillSearch(skill, 'merge')).toBe(true);
  });

  it('matches by category', () => {
    const skill = makeSkillItem({ category: '流程管理' });
    expect(matchesSkillSearch(skill, '流程')).toBe(true);
  });

  it('matches by trigger', () => {
    const skill = makeSkillItem({ trigger: '/review' });
    expect(matchesSkillSearch(skill, 'review')).toBe(true);
  });

  it('matches by description', () => {
    const skill = makeSkillItem({ description: '处理 reviewer 反馈的完整流程' });
    expect(matchesSkillSearch(skill, '反馈')).toBe(true);
  });

  it('does not match unrelated query', () => {
    const skill = makeSkillItem({ name: 'tdd', description: '测试驱动开发' });
    expect(matchesSkillSearch(skill, 'kubernetes')).toBe(false);
  });

  it('works when description is undefined', () => {
    const skill = makeSkillItem({ description: undefined });
    expect(matchesSkillSearch(skill, 'test')).toBe(true);
  });
});

describe('composeSkillItems', () => {
  it('passes description through from SkillEntry', () => {
    const governance: SkillsData = {
      skills: [
        {
          name: 'quality-gate',
          category: 'SOP',
          trigger: '/quality-gate',
          description: '开发完成后的自检门禁',
          mounts: { claude: true, codex: true, gemini: true, kimi: true },
          requiresMcp: [],
        },
      ],
      summary: { total: 1, allMounted: true, registrationConsistent: true },
      staleness: null,
      conflicts: [],
    };
    const result = composeSkillItems(governance, []);
    expect(result[0].description).toBe('开发完成后的自检门禁');
  });

  it('preserves undefined description', () => {
    const governance: SkillsData = {
      skills: [
        {
          name: 'no-desc-skill',
          category: '工具',
          trigger: '/nodesc',
          mounts: { claude: true, codex: false, gemini: false, kimi: false },
          requiresMcp: [],
        },
      ],
      summary: { total: 1, allMounted: false, registrationConsistent: true },
      staleness: null,
      conflicts: [],
    };
    const result = composeSkillItems(governance, []);
    expect(result[0].description).toBeUndefined();
  });

  it('maps pluginId from CapabilityBoardItem', () => {
    const governance: SkillsData = {
      skills: [
        {
          name: 'weixin-mp',
          category: '插件',
          trigger: '/weixin',
          mounts: { claude: true, codex: false, gemini: false, kimi: false },
          requiresMcp: [],
        },
      ],
      summary: { total: 1, allMounted: false, registrationConsistent: true },
      staleness: null,
      conflicts: [],
    };
    const caps: CapabilityBoardItem[] = [
      {
        id: 'weixin-mp',
        type: 'skill',
        source: 'cat-cafe',
        enabled: true,
        cats: { claude: true },
        pluginId: 'weixin-mp',
      },
    ];
    const result = composeSkillItems(governance, caps);
    expect(result[0].pluginId).toBe('weixin-mp');
  });

  it('pluginId is undefined when capability item has no pluginId', () => {
    const governance: SkillsData = {
      skills: [
        {
          name: 'tdd',
          category: 'SOP',
          trigger: '/tdd',
          mounts: { claude: true, codex: true, gemini: true, kimi: true },
          requiresMcp: [],
        },
      ],
      summary: { total: 1, allMounted: true, registrationConsistent: true },
      staleness: null,
      conflicts: [],
    };
    const caps: CapabilityBoardItem[] = [{ id: 'tdd', type: 'skill', source: 'cat-cafe', enabled: true, cats: {} }];
    const result = composeSkillItems(governance, caps);
    expect(result[0].pluginId).toBeUndefined();
  });
});
