import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS } from '../settings-nav-config';

describe('F190 Settings destination sections', () => {
  it('keeps the operator-defined relative order after upstream retires the separate IM section', () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);

    expect(ids).not.toContain('destinations');
    expect(ids).toEqual([
      'memory',
      'mission-hub',
      'signals',
      'members',
      'profiles',
      'accounts',
      'skills',
      'mcp',
      'plugins',
      'marketplace',
      'voice',
      'rules',
      'ops',
      'concierge',
      'notify',
      'system',
    ]);
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'memory')?.label).toBe('记忆');
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'mission-hub')?.label).toBe('Mission Hub');
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'signals')?.label).toBe('信号');
  });

  it('keeps System settings as the final secondary section', () => {
    expect(SETTINGS_SECTIONS.at(-1)?.id).toBe('system');
  });
});
