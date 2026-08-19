import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { ThreadEffortSettingsContent } from '../ThreadEffortSettings';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span data-testid="cat-avatar" /> }));

const members = [
  {
    catId: 'codex-sol',
    displayName: '小太阳·砚砚',
    options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    override: null,
    inherited: 'xhigh',
    effective: 'xhigh',
    source: 'inherited',
    compatibility: 'compatible',
    isParticipant: true,
  },
  {
    catId: 'opus',
    displayName: '宪宪',
    options: ['low', 'medium', 'high', 'max'],
    override: 'max',
    inherited: 'max',
    effective: 'max',
    source: 'thread_override',
    compatibility: 'compatible',
    isParticipant: false,
  },
];

describe('F262 ThreadEffortSettings', () => {
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
      root.render(<ThreadEffortSettingsContent threadId="thread-262" />);
    });
  }

  it('loads on mount and renders participants before other effort-capable cats', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ threadId: 'thread-262', members }), { status: 200 }),
    );
    render();
    await flush();

    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-262/members/effort');
    expect(container.textContent).toContain('本对话猫猫');
    expect(container.textContent).toContain('其他猫猫');
    expect(container.textContent?.indexOf('小太阳·砚砚')).toBeLessThan(container.textContent?.indexOf('宪宪') ?? 0);
    const solSelect = container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]');
    expect(solSelect?.value).toBe('');
    expect(solSelect?.textContent).toContain('继承（xhigh）');
  });

  it('saves immediately and keeps the selected override on success', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ threadId: 'thread-262', members }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...members[0], override: 'max', effective: 'max', source: 'thread_override' }), {
          status: 200,
        }),
      );
    render();
    await flush();

    const select = container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]');
    if (!select) throw new Error('missing Sol effort select');
    await act(async () => {
      select.value = 'max';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(apiFetch).toHaveBeenLastCalledWith('/api/threads/thread-262/members/codex-sol/effort', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'max' }),
    });
    expect(container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]')?.value).toBe('max');
  });

  it('rolls back the optimistic selection and shows an error when save fails', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ threadId: 'thread-262', members }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }));
    render();
    await flush();

    const select = container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]');
    if (!select) throw new Error('missing Sol effort select');
    await act(async () => {
      select.value = 'ultra';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]')?.value).toBe('');
    expect(container.textContent).toContain('保存失败，已恢复原设置');
  });

  it('keeps a stale raw override visible until the user changes or clears it', async () => {
    const staleMembers = [
      {
        ...members[0],
        options: ['low', 'medium', 'high', 'xhigh'],
        override: 'ultra',
        effective: 'xhigh',
        compatibility: 'incompatible',
      },
    ];
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ threadId: 'thread-262', members: staleMembers }), { status: 200 }),
    );
    render();
    await flush();

    expect(container.querySelector<HTMLSelectElement>('select[data-cat-id="codex-sol"]')?.value).toBe('ultra');
    expect(container.textContent).toContain('当前模型不支持 ultra，暂按 xhigh 运行');
  });
});
