import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { MemberCopyProvider } from '../members/editor-presentation';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';
import { writeShellLanguage } from '../shell/shell-language';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'isolated-voice-settings' }));
vi.mock('../settings/members/MemberRuntimeFields', () => ({ MemberRuntimeFields: () => null }));
vi.mock('../members/MemberCurrentStatus', () => ({ MemberCurrentStatus: () => null }));

it.each([
  'zh',
  'en',
] as const)('selects and saves a personal voice through the current settings page (%s)', async (language) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  writeShellLanguage(language);
  let cat = {
    id: 'sol-voice-settings',
    breedId: 'sol-voice-settings',
    name: 'Sol',
    displayName: 'Sol',
    clientId: 'openai',
    defaultModel: 'gpt-6.1-sol',
    mentionPatterns: ['@sol-voice-settings'],
    color: { primary: '#123456', secondary: '#abcdef' },
    configurationRevision: '1'.repeat(64),
  } as CatData;
  const voiceConfig = {
    voice: 'preset',
    langCode: 'zh',
    speed: 1,
    refAudio: 'genshin/雷泽/clip.wav',
    refText: '原文。',
  };
  const choice = {
    id: 'maine-coon:codex-spark',
    label: '雷泽',
    familyId: 'maine-coon',
    familyName: '缅因猫',
    available: true,
    voiceConfig,
  };
  const writes: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/tts/voices') return Response.json({ voices: [choice] });
    if (path === '/api/accounts') return Response.json({ providers: [], projectPath: '/fixture' });
    if (path === '/api/session') return Response.json({ userId: cat.id });
    if (path === '/api/cat-templates') return Response.json({ templates: [] });
    if (path === `/api/cats/${cat.id}` && init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      writes.push(payload);
      cat = { ...cat, voiceConfig: payload.voiceConfig, configurationRevision: '2'.repeat(64) };
      return Response.json({ cat });
    }
    return Response.json({ cats: [cat] });
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (key: string) =>
    root.render(
      <MemberCopyProvider>
        <MemberSettingsPage key={key} cat={cat} cats={[cat]} onSaved={vi.fn()} onBack={vi.fn()} />
      </MemberCopyProvider>,
    );
  const click = async (name: string) => {
    const button = [...host.querySelectorAll('button')].find((node) => node.textContent === name);
    expect(button, name).toBeDefined();
    await act(async () => button?.click());
  };
  try {
    await act(async () => render('before'));
    await click(language === 'zh' ? '语音' : 'Voice');
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Voice choice"]');
    expect(select, 'the actual Voice section must expose existing voice choices').not.toBeNull();
    expect(host.textContent).toContain(language === 'zh' ? '选择声线' : 'Choose a voice');
    expect(select?.value).toBe('');
    expect(writes).toHaveLength(0);
    await act(async () => {
      if (!select) throw new Error('voice choices missing');
      select.value = choice.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(writes).toHaveLength(0);
    await click(language === 'zh' ? '保存' : 'Save');
    expect(writes).toEqual([{ voiceConfig, expectedRevision: '1'.repeat(64) }]);
    await act(async () => render('reopened'));
    await click(language === 'zh' ? '语音' : 'Voice');
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Voice choice"]')?.value).toBe(choice.id);
    expect(writes).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    sessionStorage.clear();
    writeShellLanguage('zh');
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  }
});
