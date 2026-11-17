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

function bodyOf(call: unknown[]) {
  const init = call[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}'));
}

function phrasePosts() {
  return apiFetch.mock.calls.filter(([url, init]) => url === phrasePath && init?.method === 'POST');
}

function usageWrites() {
  return phrasePosts().filter((call) => 'id' in bodyOf(call));
}

function saveWrites() {
  return phrasePosts().filter((call) => 'text' in bodyOf(call));
}

function typeDraft(textarea: HTMLTextAreaElement | null, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

  await act(async () => root.render(<ChatInput presentation="v2" onSend={onSend} />));
  await click('快捷用语');
  await vi.waitFor(() => expect(getButton(saved)).toBeDefined());
  expect(phrasePosts()).toHaveLength(0);
  await click(saved);
  await vi.waitFor(() => expect(usageWrites()).toHaveLength(1));
  expect(bodyOf(usageWrites()[0])).toEqual({ id: 'saved' });
  expect(usageWrites()[0]?.[2]).toEqual({ mutationTimeoutMs: 185_000, notifyFailure: false });
  const textarea = container.querySelector('textarea');
  expect(textarea?.value).toBe(saved);
  expect(onSend).not.toHaveBeenCalled();

  const next = '请先核对失败用例';
  typeDraft(textarea, next);
  await click('快捷用语');
  expect(document.body.textContent).toContain('是否保存成快捷用语');
  await click('否');
  expect(saveWrites()).toHaveLength(0);
  await click('快捷用语');
  await click('是');
  const [write] = saveWrites();
  expect(bodyOf(write)).toEqual({ text: next });
  expect(write?.[2]).toEqual({ mutationTimeoutMs: 185_000 });
  expect(textarea?.value).toBe(next);
  expect(onSend).not.toHaveBeenCalled();
});

it('does not insert or count a phrase when a newer draft makes the selection stale', async () => {
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

  await act(async () => root.render(<ChatInput presentation="v2" onSend={onSend} />));
  await click('快捷用语');
  await vi.waitFor(() => expect(getButton(saved)).toBeDefined());
  const textarea = container.querySelector('textarea');
  typeDraft(textarea, '更新的草稿');
  expect(textarea?.value).toBe('更新的草稿');
  await click(saved);
  expect(textarea?.value).toBe('更新的草稿');
  expect(usageWrites()).toHaveLength(0);
  expect(saveWrites()).toHaveLength(0);
});

it('retries the usage notification once after a CAS conflict', async () => {
  const saved = '复核 #1898 的修改';
  let usagePosts = 0;
  apiFetch.mockImplementation(async (url, init) => {
    if (url === discovery) {
      return Response.json({
        entries: [
          { pluginId: 'official.quick-phrases', instanceId: 'phrases', resourcePath: 'phrases', generation: 'active' },
        ],
      });
    }
    if (String(url).startsWith(phrasePath)) {
      if (init?.method === 'POST') {
        usagePosts += 1;
        return usagePosts === 1 ? Response.json({ error: 'conflict' }, { status: 409 }) : Response.json({ ok: true });
      }
      return Response.json({ items: [{ id: 'saved', text: saved }], page: 1, totalPages: 1 });
    }
    return Response.json({});
  });
  const click = async (label: string) => {
    const target = getButton(label);
    expect(target).toBeDefined();
    await act(async () => target?.click());
  };

  await act(async () => root.render(<ChatInput presentation="v2" onSend={onSend} />));
  await click('快捷用语');
  await vi.waitFor(() => expect(getButton(saved)).toBeDefined());
  await click(saved);
  await vi.waitFor(() => expect(usageWrites()).toHaveLength(2));
  expect(usagePosts).toBe(2);
  expect(container.querySelector('textarea')?.value).toBe(saved);
  expect(onSend).not.toHaveBeenCalled();
});

it('does not retry when the plugin rejects usage with 400', async () => {
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
      if (init?.method === 'POST') return Response.json({ error: 'Invalid request' }, { status: 400 });
      return Response.json({ items: [{ id: 'saved', text: saved }], page: 1, totalPages: 1 });
    }
    return Response.json({});
  });
  const click = async (label: string) => {
    const target = getButton(label);
    expect(target).toBeDefined();
    await act(async () => target?.click());
  };

  await act(async () => root.render(<ChatInput presentation="v2" onSend={onSend} />));
  await click('快捷用语');
  await vi.waitFor(() => expect(getButton(saved)).toBeDefined());
  await click(saved);
  await vi.waitFor(() => expect(usageWrites()).toHaveLength(1));
  expect(container.querySelector('textarea')?.value).toBe(saved);
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
});

it('keeps the selected phrase when the usage notification fails', async () => {
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
      if (init?.method === 'POST') throw new Error('offline');
      return Response.json({ items: [{ id: 'saved', text: saved }], page: 1, totalPages: 1 });
    }
    return Response.json({});
  });
  const click = async (label: string) => {
    const target = getButton(label);
    expect(target).toBeDefined();
    await act(async () => target?.click());
  };

  await act(async () => root.render(<ChatInput presentation="v2" onSend={onSend} />));
  await click('快捷用语');
  await vi.waitFor(() => expect(getButton(saved)).toBeDefined());
  await click(saved);
  await vi.waitFor(() => expect(usageWrites()).toHaveLength(1));
  expect(container.querySelector('textarea')?.value).toBe(saved);
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  expect(onSend).not.toHaveBeenCalled();
});

it('does not report usage when deleting a phrase', async () => {
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
      if (init?.method === 'DELETE') return Response.json({ ok: true });
      return Response.json({ items: [{ id: 'saved', text: saved }], page: 1, totalPages: 1 });
    }
    return Response.json({});
  });
  const click = async (label: string) => {
    const target = getButton(label);
    expect(target).toBeDefined();
    await act(async () => target?.click());
  };

  await act(async () => root.render(<ChatInput presentation="v2" onSend={onSend} />));
  await click('快捷用语');
  await vi.waitFor(() => expect(getButton(saved)).toBeDefined());
  await click('删除快捷用语');
  await click('是');
  expect(apiFetch.mock.calls.some(([url, init]) => url === phrasePath && init?.method === 'DELETE')).toBe(true);
  expect(phrasePosts()).toHaveLength(0);
});
