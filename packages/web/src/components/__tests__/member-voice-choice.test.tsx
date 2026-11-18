import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../hub-cat-editor.model';
import { VoiceConfigSection } from '../hub-cat-editor-voice';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.resetAllMocks();
});

it('loading choices preserves the current voice; choosing one replaces the whole draft without saving another member', async () => {
  const voiceConfig = {
    voice: 'zm_yunjian',
    langCode: 'zh',
    speed: 1,
    refAudio: 'genshin/魈/clip.wav',
    refText: '参考台词。',
    instruct: '少年',
    temperature: 0.3,
  };
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({
      voices: [
        {
          id: 'maine-coon:codex-default',
          familyId: 'maine-coon',
          familyName: '缅因猫',
          label: '魈',
          sourceCatId: 'codex',
          voiceConfig,
          available: true,
        },
      ],
    }),
  );
  const form = {
    ...initialState(),
    catId: 'codex61-sol',
    voiceVoice: 'existing',
    voiceRefAudio: '/uploads/old.wav',
    voiceInstruct: 'old instruction',
  };
  const onChange = vi.fn();
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () =>
    root?.render(<VoiceConfigSection form={form} onChange={onChange} onRefAudioUpload={vi.fn()} />),
  );
  expect(onChange).not.toHaveBeenCalled();
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Voice choice"]');
  expect(select?.textContent).toContain('缅因猫 · 魈');
  await act(async () => {
    if (select) {
      select.value = 'maine-coon:codex-default';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  expect(onChange).toHaveBeenCalledWith({
    voiceVoice: 'zm_yunjian',
    voiceLangCode: 'zh',
    voiceSpeed: '1',
    voiceRefAudio: voiceConfig.refAudio,
    voiceRefText: voiceConfig.refText,
    voiceInstruct: '少年',
    voiceTemperature: '0.3',
  });
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('failed candidate reads keep manual voice fields available and expose a retry', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response('', { status: 503 }));
  const form = { ...initialState(), voiceVoice: 'keep-me' };
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root?.render(<VoiceConfigSection form={form} onChange={vi.fn()} onRefAudioUpload={vi.fn()} />));
  expect(container.textContent).toContain('声线列表暂时读不到');
  expect(container.textContent).toContain('重试');
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Voice Name"]')?.value).toBe('keep-me');
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ voices: [] }));
  const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '重试');
  await act(async () => retry?.click());
  expect(container.textContent).not.toContain('声线列表暂时读不到');
  expect(container.textContent).toContain('还没有可用的候选声线');
});
