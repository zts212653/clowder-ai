import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { ThreadSpeedSettingsContent } from '../ThreadSpeedSettings';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span data-testid="cat-avatar" /> }));

const members = [
  {
    catId: 'codex-sol',
    displayName: '小太阳·砚砚',
    options: ['standard', 'fast'],
    override: null,
    inherited: 'fast',
    requested: 'fast',
    source: 'member_default',
    compatibility: 'compatible',
    isParticipant: true,
  },
  {
    catId: 'codex-terra',
    displayName: 'Terra',
    options: ['standard', 'fast'],
    override: 'standard',
    inherited: null,
    requested: 'standard',
    source: 'thread_override',
    compatibility: 'compatible',
    isParticipant: false,
  },
];

describe('F291 ThreadSpeedSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function render() {
    act(() => {
      root.render(<ThreadSpeedSettingsContent threadId="thread-291" />);
    });
  }

  it('loads on mount, renders participant-first OAuth Codex rows, and says requested rather than actual', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ threadId: 'thread-291', members }), { status: 200 }),
    );
    render();
    await flush();

    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-291/members/speed');
    expect(container.textContent?.indexOf('小太阳·砚砚')).toBeLessThan(container.textContent?.indexOf('Terra') ?? 0);
    expect(container.textContent).toContain('只表示向 Codex 请求的档位');
    expect(container.textContent).not.toContain('实际生效');
    expect(container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]')?.textContent).toContain(
      '继承（成员 Fast）',
    );
  });

  it('saves immediately, clears to inheritance, and rolls back failed optimistic changes', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ threadId: 'thread-291', members }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...members[0], override: 'standard', requested: 'standard', source: 'thread_override' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 500 }));
    render();
    await flush();

    const select = container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]');
    if (!select) throw new Error('missing Sol speed select');
    await act(async () => {
      select.value = 'standard';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(apiFetch).toHaveBeenLastCalledWith('/api/threads/thread-291/members/codex-sol/speed', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed: 'standard' }),
    });

    const saved = container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]');
    if (!saved) throw new Error('missing saved speed select');
    await act(async () => {
      saved.value = '';
      saved.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]')?.value).toBe('standard');
    expect(container.textContent).toContain('保存失败，已恢复原设置');
  });

  it('keeps a stale Fast override visible while explaining that the model cannot request it', async () => {
    const stale = [
      { ...members[0], options: ['standard'], override: 'fast', requested: null, compatibility: 'incompatible' },
    ];
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ threadId: 'thread-291', members: stale }), { status: 200 }),
    );
    render();
    await flush();

    expect(container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]')?.value).toBe('fast');
    expect(container.textContent).toContain('当前模型不能请求 Fast，本轮将继承 Codex 设置');
  });
});
