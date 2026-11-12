import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../../ChatInput';
import { writeShellLanguage } from '../../shell/shell-language';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('@/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', startRecording: vi.fn(), stopRecording: vi.fn() }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));

const phrasePath = '/api/plugins/official.quick-phrases/phrases';
const discovery = '/api/plugin-ui?group=composer.quick-phrases';
const onSend = vi.fn();
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  writeShellLanguage('zh');
  apiFetch.mockReset();
  onSend.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function getButton(label: string) {
  return [...document.body.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent === label,
  );
}

it('does not show an entry while the plugin is inactive', async () => {
  apiFetch.mockImplementation(async () => Response.json({ entries: [] }));
  await act(async () => root.render(<ChatInput presentation="v2" onSend={onSend} />));
  expect(getButton('快捷用语')).toBeUndefined();
});

it('selects a saved phrase and sends the draft to storage only after confirmation', async () => {
  const saved = '复核 #1898 的修改';
  apiFetch.mockImplementation(async (url, init) => {
    if (url === discovery) {
      return Response.json({
        entries: [
          { pluginId: 'official.quick-phrases', instanceId: 'phrases', resourcePath: 'phrases', generation: 'active' },
        ],
      });
    }
    if (String(url).startsWith(phrasePath)) {
      if (init?.method === 'POST') return Response.json({ ok: true });
      return Response.json({ items: [{ id: 'saved', text: saved }], page: 1, totalPages: 1 });
    }
    return Response.json({});
  });
  const click = async (label: string) => {
    const target = getButton(label);
    expect(target).toBeDefined();
    await act(async () => target?.click());
  };
  const phraseWrites = () => apiFetch.mock.calls.filter(([url, init]) => url === phrasePath && init?.method === 'POST');

  await act(async () => root.render(<ChatInput presentation="v2" onSend={onSend} />));
  await click('快捷用语');
  await vi.waitFor(() => expect(getButton(saved)).toBeDefined());
  await click(saved);
  const textarea = container.querySelector('textarea');
  expect(textarea?.value).toBe(saved);
  expect(onSend).not.toHaveBeenCalled();

  const next = '请先核对失败用例';
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, next);
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('快捷用语');
  expect(document.body.textContent).toContain('是否保存成快捷用语');
  await click('否');
  expect(phraseWrites()).toHaveLength(0);
  await click('快捷用语');
  await click('是');
  const [write] = phraseWrites();
  expect(JSON.parse(String(write?.[1]?.body))).toEqual({ text: next });
  expect(textarea?.value).toBe(next);
  expect(onSend).not.toHaveBeenCalled();
});
