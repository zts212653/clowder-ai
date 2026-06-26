import { describe, expect, it } from 'vitest';
import type { CapabilityBoardItem } from '../../capability-board-ui';
import { composeSkillItems, matchesSkillSearch, type SettingsSkillItem } from '../skills-types';

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
    controls: { source: 'cat-cafe', enabled: true, cats: {}, canToggle: true },
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

// composeSkillItems iterates CapabilityBoardItem[] as the sole data source.
describe('composeSkillItems', () => {
  it('passes description through from capability item', () => {
    const caps: CapabilityBoardItem[] = [
      {
        id: 'quality-gate',
        type: 'skill',
        source: 'cat-cafe',
        enabled: true,
        cats: {},
        description: '开发完成后的自检门禁',
        category: 'SOP',
        triggers: ['/quality-gate'],
      },
    ];
    const result = composeSkillItems(caps);
    expect(result[0].description).toBe('开发完成后的自检门禁');
  });

  it('preserves undefined description', () => {
    const caps: CapabilityBoardItem[] = [
      { id: 'no-desc-skill', type: 'skill', source: 'cat-cafe', enabled: true, cats: {} },
    ];
    const result = composeSkillItems(caps);
    expect(result[0].description).toBeUndefined();
  });

  it('maps pluginId from CapabilityBoardItem', () => {
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
    const result = composeSkillItems(caps);
    expect(result[0].pluginId).toBe('weixin-mp');
  });

  it('pluginId is undefined when capability item has no pluginId', () => {
    const caps: CapabilityBoardItem[] = [{ id: 'tdd', type: 'skill', source: 'cat-cafe', enabled: true, cats: {} }];
    const result = composeSkillItems(caps);
    expect(result[0].pluginId).toBeUndefined();
  });

  it('prefers globalEnabled for skill controls when present', () => {
    const caps: CapabilityBoardItem[] = [
      { id: 'tdd', type: 'skill', source: 'cat-cafe', enabled: false, globalEnabled: true, cats: {} },
    ];
    const result = composeSkillItems(caps);
    expect(result[0].controls?.enabled).toBe(true);
  });

  it('non-plugin and plugin capabilities with same id are separate items', () => {
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

    const result = composeSkillItems(caps);

    // Both appear as separate items — capabilities is the iteration source
    expect(result).toHaveLength(2);
    expect(result[0].pluginId).toBeUndefined();
    expect(result[0].mountPaths).toEqual(['claude']);
    expect(result[0].controls?.enabled).toBe(true);
    expect(result[1].pluginId).toBe('same-id-plugin');
    // Plugin skills now have the same controls as built-in skills
    expect(result[1].controls).toEqual({
      source: 'cat-cafe',
      enabled: false,
      cats: { codex: false },
      canToggle: true,
    });
  });

  it('exposes same skill controls for plugin-owned skills', () => {
    const caps: CapabilityBoardItem[] = [
      {
        id: 'weixin-mp',
        type: 'skill',
        source: 'cat-cafe',
        enabled: true,
        cats: {},
        pluginId: 'weixin-mp',
      },
    ];

    const result = composeSkillItems(caps);

    expect(result[0].pluginId).toBe('weixin-mp');
    // Plugin skills get the same controls as built-in skills — no special handling
    expect(result[0].controls).toEqual({
      source: 'cat-cafe',
      enabled: true,
      cats: {},
      canToggle: true,
    });
  });

  it('reads mount data from CapabilityBoardItem mounts', () => {
    const caps: CapabilityBoardItem[] = [
      {
        id: 'debugging',
        type: 'skill',
        source: 'cat-cafe',
        enabled: true,
        cats: {},
        mounts: { claude: true, codex: true, gemini: true, kimi: false },
      },
    ];
    const result = composeSkillItems(caps);
    expect(result[0].governance.mountedCount).toBe(3);
    expect(result[0].governance.mounts.claude).toBe(true);
    expect(result[0].governance.mounts.kimi).toBe(false);
  });

  it('preserves backend per-skill mount health requirements', () => {
    const caps: CapabilityBoardItem[] = [
      {
        id: 'debugging',
        type: 'skill',
        source: 'cat-cafe',
        enabled: true,
        cats: {},
        mounts: { claude: true, codex: true, gemini: true, kimi: false },
        mountHealth: {
          enabledMountPoints: ['claude', 'codex', 'gemini'],
          mountedCount: 3,
          requiredCount: 3,
          allMounted: true,
        },
      },
    ];
    const result = composeSkillItems(caps);
    expect(result[0].governance.mountedCount).toBe(3);
    expect(result[0].governance.requiredMountCount).toBe(3);
    expect(result[0].governance.allMounted).toBe(true);
    expect(result[0].governance.enabledMountPoints).toEqual(['claude', 'codex', 'gemini']);
  });
});
