import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS_ENTRY_ID,
  destPinId,
  entryForSection,
  entryForSelection,
  findEntry,
  resolvePin,
  SETTINGS_IA,
  TEAM_WORKSPACE_PIN_ID,
} from '../settings-ia';
import { SETTINGS_SECTIONS } from '../settings-nav-config';

describe('F322 设置与管理 information architecture', () => {
  it('has exactly the 11 decided first-level items, in the decided order and groups', () => {
    expect(SETTINGS_IA.map((entry) => entry.label)).toEqual([
      '猫猫团队',
      '调度',
      '能力进化',
      '评估',
      '连接与扩展',
      '系统',
      '主题',
      '社区',
      '猫猫星球',
      'Mission Hub',
      '信号',
    ]);
    expect(SETTINGS_IA.map((entry) => entry.group)).toEqual([1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3]);
    expect(new Set(SETTINGS_IA.map((entry) => entry.id)).size).toBe(SETTINGS_IA.length);
  });

  it('lands on 猫猫团队 › 成员与运行时, the same default the old settings page had', () => {
    expect(DEFAULT_SETTINGS_ENTRY_ID).toBe('team');
    const team = findEntry('team');
    expect(team?.destination.kind).toBe('sections');
    if (team?.destination.kind !== 'sections') throw new Error('team must be a sections entry');
    expect(team.destination.items[0]).toEqual({ kind: 'section', sectionId: 'members' });
  });

  it('keeps every one of the 14 old sections, each under exactly one first-level item', () => {
    for (const section of SETTINGS_SECTIONS) {
      const owners = SETTINGS_IA.filter(
        (entry) =>
          entry.destination.kind === 'sections' &&
          entry.destination.items.some((item) => item.kind === 'section' && item.sectionId === section.id),
      );
      expect(owners, `section ${section.id} must have exactly one owner`).toHaveLength(1);
      expect(entryForSection(section.id)).toBe(owners[0]);
    }
    expect(SETTINGS_SECTIONS).toHaveLength(14);
  });

  it('maps the decided sections: accounts (模型账户与密钥) stays under 连接与扩展', () => {
    expect(entryForSection('accounts')?.id).toBe('connect');
    expect(entryForSection('members')?.id).toBe('team');
    expect(entryForSection('concierge')?.id).toBe('team');
    expect(entryForSection('ops')?.id).toBe('system');
    expect(entryForSelection('theme')?.id).toBe('theme');
    expect(entryForSelection('not-a-section')).toBeUndefined();
  });

  it('points the other entries at the place that already owns them', () => {
    expect(findEntry('starry')?.destination).toEqual({ kind: 'route', path: '/starry' });
    expect(findEntry('mission')?.destination).toEqual({ kind: 'route', path: '/mission-hub' });
    expect(findEntry('signals')?.destination).toEqual({ kind: 'route', path: '/signals' });
    expect(findEntry('schedule')?.destination).toEqual({ kind: 'workspace-mode', mode: 'schedule' });
    expect(findEntry('eval')?.destination).toEqual({ kind: 'workspace-mode', mode: 'eval' });
    expect(findEntry('community')?.destination).toEqual({ kind: 'workspace-mode', mode: 'community' });
  });
});

describe('F322 pins above the mailbox', () => {
  it('old pins (bare settings section ids) keep resolving so nobody loses a pin', () => {
    const pin = resolvePin('notify');
    expect(pin).toMatchObject({ kind: 'section', id: 'notify', label: '通知' });
  });

  it('new pins are namespaced so a first-level "系统" can never collide with the old "系统配置" section id', () => {
    expect(destPinId('system')).toBe('dest:system');
    expect(resolvePin('system')).toMatchObject({ kind: 'section', label: '系统配置' });
    expect(resolvePin('dest:system')).toMatchObject({ kind: 'entry', label: '系统' });
    expect(resolvePin('dest:signals')).toMatchObject({ kind: 'entry', label: '信号' });
  });

  it('the Workspace team panel has its own pin identity and never resolves to the settings members section', () => {
    expect(TEAM_WORKSPACE_PIN_ID).not.toBe(destPinId('team'));
    expect(resolvePin(TEAM_WORKSPACE_PIN_ID)).toMatchObject({ kind: 'workspace-team', label: '成员能力与路由状态' });
    expect(resolvePin('dest:team')).toMatchObject({ kind: 'entry', label: '猫猫团队' });
  });

  it('an unknown or retired pin id resolves to nothing instead of crashing the rail', () => {
    expect(resolvePin('dest:nope')).toBeNull();
    expect(resolvePin('retired-section')).toBeNull();
    expect(resolvePin('')).toBeNull();
  });
});
