import { describe, expect, it } from 'vitest';
import { checkShellCopyParity } from '../../shell/__tests__/shell-copy-parity-check';
import { SETTINGS_IA } from '../settings-ia';
import { SETTINGS_SECTIONS } from '../settings-nav-config';
import { settingsShellCopy } from '../settings-shell.shell-copy';
import { themeSettingsCopy } from '../theme-settings.shell-copy';

describe('the 设置与管理 catalogue words follow settings-ia, which stays the structure', () => {
  const ids = SETTINGS_IA.map((entry) => entry.id);

  it('every first-level entry has a word in both languages, and no word is left without an entry', () => {
    for (const language of ['zh', 'en'] as const) {
      expect(Object.keys(settingsShellCopy[language].entries).sort(), language).toEqual([...ids].sort());
    }
  });

  it('the Chinese word is the label settings-ia still carries (the rail pins read that label)', () => {
    for (const entry of SETTINGS_IA) {
      const zh = settingsShellCopy.zh.entries as Record<string, string>;
      expect(zh[entry.id], entry.id).toBe(entry.label);
    }
  });

  it('covers every existing secondary section in both languages without a Chinese fallback in English', () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id).sort();
    expect(Object.keys(settingsShellCopy.zh.sections).sort()).toEqual(ids);
    expect(Object.keys(settingsShellCopy.en.sections).sort()).toEqual(ids);
    for (const section of SETTINGS_SECTIONS) {
      expect(settingsShellCopy.zh.sections[section.id]).toBe(section.label);
      expect((settingsShellCopy.en.sections as Record<string, string>)[section.id]).not.toMatch(/\p{Script=Han}/u);
    }
    expect(checkShellCopyParity(settingsShellCopy)).toEqual([]);
  });

  it('the English names are the approved table, not a translation made on the spot', () => {
    expect(settingsShellCopy.en.title).toBe('Settings');
    expect(settingsShellCopy.en.entries).toEqual({
      you: 'You',
      team: 'Cat team',
      schedule: 'Scheduling',
      evolution: 'Capability evolution',
      eval: 'Evaluation',
      connect: 'Integrations', // "Connections & extensions" wraps to two lines at 232px
      system: 'System',
      theme: 'Theme',
      community: 'Community',
      starry: 'Cat Planet',
      mission: 'Mission Hub',
      signals: 'Signals',
    });
  });
});

describe('界面语言 — what each language is called, in the language being read', () => {
  it('Chinese says 英文 for English and keeps 中文（简体） for itself; English says Chinese (Simplified) for Chinese', () => {
    expect(themeSettingsCopy.zh.language.names).toEqual({ chinese: '中文（简体）', english: '英文' });
    expect(themeSettingsCopy.en.language.names).toEqual({ chinese: 'Chinese (Simplified)', english: 'English' });
  });

  it('both explanations say the classic interface is not affected (the template draws "only Chinese", which is not true)', () => {
    expect(themeSettingsCopy.zh.language.note).toContain('经典界面不受此设置影响');
    expect(themeSettingsCopy.en.language.note).toContain('This setting does not affect the classic interface.');
    expect(themeSettingsCopy.en.language.note).not.toMatch(/Chinese only|only Chinese|is Chinese/i);
  });
});
