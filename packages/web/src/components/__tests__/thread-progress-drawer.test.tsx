import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadProgressDrawer } from '../ThreadProgressDrawer';

const apiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({ setWorkspaceMode: vi.fn(), setRightPanelMode: vi.fn(), setRightPanelOpen: vi.fn() }),
  },
}));

describe('ThreadProgressDrawer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            v: 1,
            id: 'internal-receipt-id',
            ownerUserId: 'owner-id',
            threadId: 'thread-1',
            kind: 'milestone',
            impactAxes: ['verified_outcome'],
            actor: { kind: 'cat', catId: 'internal-cat-id' },
            headline: '完成 Receipt 基础链路',
            detail: '共享契约、callback 与幂等存储已通过。',
            nextStep: '进入单会话验收',
            provenance: [{ kind: 'invocation', invocationId: 'internal-invocation-id' }],
            sourceKey: 'internal-source-key',
            occurredAt: Date.now(),
            createdAt: Date.now(),
          },
        ],
        nextCursor: null,
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders an overlay with human-readable history and no internal identifiers', async () => {
    await act(async () => {
      root.render(
        <ThreadProgressDrawer open docked={false} threadId="thread-1" onClose={vi.fn()} runDetails={<p>运行控制</p>} />,
      );
    });
    await act(async () => Promise.resolve());

    const drawer = container.querySelector('[data-testid="thread-progress-drawer"]');
    expect(drawer?.getAttribute('data-presentation')).toBe('overlay');
    expect(container.textContent).toContain('完成 Receipt 基础链路');
    expect(container.textContent).toContain('进入单会话验收');
    expect(container.textContent).not.toContain('internal-receipt-id');
    expect(container.textContent).not.toContain('internal-invocation-id');
    const backdrop = container.querySelector('[aria-label="关闭完整进展"]');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.getAttribute('tabindex')).toBe('-1');
  });

  it('closes on Escape and exposes existing run details on the second tab', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <ThreadProgressDrawer open docked threadId="thread-1" onClose={onClose} runDetails={<p>运行控制</p>} />,
      );
    });
    const runTab = [...container.querySelectorAll('button')].find((button) => button.textContent === '运行详情');
    await act(async () => runTab?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('运行控制');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the newest invalidation page when an older request resolves last', async () => {
    let resolveOlder: (value: unknown) => void = () => {};
    let resolveNewer: (value: unknown) => void = () => {};
    const older = new Promise((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise((resolve) => {
      resolveNewer = resolve;
    });
    apiFetch.mockReset();
    apiFetch.mockReturnValueOnce(older).mockReturnValueOnce(newer);

    await act(async () => {
      root.render(<ThreadProgressDrawer open docked threadId="thread-1" onClose={vi.fn()} />);
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('catcafe:thread-brief-invalidated', { detail: { threadId: 'thread-1' } }));
    });
    await act(async () => {
      resolveNewer({
        ok: true,
        json: async () => ({ items: [{ ...defaultReceipt(), headline: '最新进展' }], nextCursor: null }),
      });
      await Promise.resolve();
    });
    await act(async () => {
      resolveOlder({
        ok: true,
        json: async () => ({ items: [{ ...defaultReceipt(), headline: '旧进展' }], nextCursor: null }),
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('最新进展');
    expect(container.textContent).not.toContain('旧进展');
  });
});

function defaultReceipt() {
  return {
    v: 1,
    id: 'race-receipt',
    ownerUserId: 'owner-id',
    threadId: 'thread-1',
    kind: 'milestone',
    impactAxes: ['verified_outcome'],
    actor: { kind: 'cat', catId: 'internal-cat-id' },
    provenance: [{ kind: 'invocation', invocationId: 'internal-invocation-id' }],
    sourceKey: 'race-source-key',
    occurredAt: Date.now(),
    createdAt: Date.now(),
  };
}
