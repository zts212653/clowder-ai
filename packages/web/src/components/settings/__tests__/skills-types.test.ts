import { describe, expect, it } from 'vitest';
import type { CapabilityBoardItem } from '../../capability-board-ui';
import { composeSkillItems, matchesSkillSearch, type SettingsSkillItem, type SkillsData } from '../skills-types';

function makeSkillItem(overrides: Partial<SettingsSkillItem> = {}): SettingsSkillItem {
  return {
    id: 'test-skill',
    name: 'test-skill',
    category: '工具',
    trigger: '/test',
    source: 'cat-cafe',
    governance: {
      mounts: { claude: true, codex: true, gemini: false, kimi: false },
      mountedCount: 2,
      requiredMountCount: 4,
      allMounted: false,
      enabledMountPoints: ['claude', 'codex', 'gemini', 'kimi'],
      requiresMcp: [],
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
    };
    const caps: CapabilityBoardItem[] = [{ id: 'tdd', type: 'skill', source: 'cat-cafe', enabled: true, cats: {} }];
    const result = composeSkillItems(governance, caps);
    expect(result[0].pluginId).toBeUndefined();
  });

  it('prefers globalEnabled for skill controls when present', () => {
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
    };
    const caps: CapabilityBoardItem[] = [
      { id: 'tdd', type: 'skill', source: 'cat-cafe', enabled: false, globalEnabled: true, cats: {} },
    ];

    const result = composeSkillItems(governance, caps);

    expect(result[0].controls?.enabled).toBe(true);
  });

  it('prefers non-plugin Clowder AI capabilities for same-id source skills', () => {
    const governance: SkillsData = {
      skills: [
        {
          name: 'debugging',
          category: 'SOP',
          trigger: '/debugging',
          source: 'cat-cafe',
          globalEnabled: true,
          mountPaths: ['claude'],
          mounts: { claude: true, codex: false, gemini: false, kimi: false },
          requiresMcp: [],
        },
      ],
      summary: { total: 1, allMounted: false, registrationConsistent: true },
      staleness: null,
    };
    const caps: CapabilityBoardItem[] = [
      {
        id: 'debugging',
        type: 'skill',
        source: 'cat-cafe',
        enabled: true,
        cats: { codex: true },
        mountPaths: ['claude'],
      },
      {
        id: 'debugging',
        type: 'skill',
        source: 'cat-cafe',
        enabled: false,
        cats: { codex: false },
        pluginId: 'same-id-plugin',
        mountPaths: [],
      },
    ];

    const result = composeSkillItems(governance, caps);

    expect(result[0].pluginId).toBeUndefined();
    expect(result[0].mountPaths).toEqual(['claude']);
    expect(result[0].controls?.enabled).toBe(true);
  });

  it('uses mount-point-aware mount health when disabled mount points are intentionally unmounted', () => {
    const governance: SkillsData = {
      skills: [
        {
          name: 'debugging',
          category: '工具',
          trigger: '/debug',
          mounts: { claude: true, codex: true, gemini: true, kimi: false },
          mountHealth: {
            enabledMountPoints: ['claude', 'codex', 'gemini'],
            mountedCount: 3,
            requiredCount: 3,
            allMounted: true,
          },
          requiresMcp: [],
        },
      ],
      summary: { total: 1, allMounted: true, registrationConsistent: true },
      staleness: null,
    };
    const result = composeSkillItems(governance, []);
    expect(result[0].governance.mountedCount).toBe(3);
    expect(result[0].governance.requiredMountCount).toBe(3);
    expect(result[0].governance.allMounted).toBe(true);
  });
});
