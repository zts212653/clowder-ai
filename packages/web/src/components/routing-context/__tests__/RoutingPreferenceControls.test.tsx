import type { RoutingPreferenceRevisionV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  supersede: vi.fn(),
  retire: vi.fn(),
}));

vi.mock('../routing-context-client', () => ({
  RoutingContextCommandError: class RoutingContextCommandError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  createRoutingPreference: (...args: unknown[]) => mocks.create(...args),
  supersedeRoutingPreference: (...args: unknown[]) => mocks.supersede(...args),
  retireRoutingPreference: (...args: unknown[]) => mocks.retire(...args),
}));

const activeRevision = {
  v: 1,
  preferenceId: 'preference-1',
  revisionId: 'revision-2',
  commandId: 'command-2',
  ownerId: 'owner-1',
  lifecycle: 'active',
  appliesWhen: { intent: 'review' },
  prefer: [{ type: 'cat', catId: 'opus5' }],
  over: [{ type: 'cat', catId: 'codex-sol' }],
  rationale: '终审优先',
  evidenceRefs: ['decision:F293'],
  version: 2,
  validFrom: 1_800_000_000_000,
  reviewAfter: 1_800_086_400_000,
  supersedesRevisionId: 'revision-1',
} satisfies RoutingPreferenceRevisionV1;

const typedRevision = {
  ...activeRevision,
  appliesWhen: { intent: 'review' as const, requireEligible: [{ type: 'cat' as const, catId: 'codex-sol' }] },
  prefer: [{ type: 'provider' as const, providerId: 'anthropic' }],
  over: [{ type: 'quota_pool' as const, poolId: 'private-review' }],
};

describe('F293 RoutingPreferenceControls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps a new preference draft when the durable append fails', async () => {
    mocks.create.mockRejectedValueOnce(new Error('偏好写入失败'));
    const { RoutingPreferenceControls } = await import('../RoutingPreferenceControls');
    await act(async () => root.render(<RoutingPreferenceControls revisions={[]} onChanged={vi.fn()} />));

    const prefer = container.querySelector<HTMLInputElement>('[name="preference-prefer"]');
    const over = container.querySelector<HTMLInputElement>('[name="preference-over"]');
    const rationale = container.querySelector<HTMLInputElement>('[name="preference-rationale"]');
    if (!prefer || !over || !rationale) throw new Error('preference draft inputs were not rendered');
    act(() => {
      Simulate.change(prefer, { target: { value: 'opus5' } } as never);
      Simulate.change(over, { target: { value: 'codex-sol' } } as never);
      Simulate.change(rationale, { target: { value: '复杂终审' } } as never);
    });
    await act(async () =>
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );

    expect(container.textContent).toContain('偏好写入失败');
    expect(rationale.value).toBe('复杂终审');
  });

  it('renews from the exact active head and then refetches canonical truth', async () => {
    mocks.supersede.mockResolvedValueOnce({ outcome: 'appended' });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const { RoutingPreferenceControls } = await import('../RoutingPreferenceControls');
    await act(async () =>
      root.render(<RoutingPreferenceControls revisions={[activeRevision]} onChanged={onChanged} />),
    );

    const renew = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('续期'));
    await act(async () => renew?.click());

    expect(mocks.supersede).toHaveBeenCalledWith(
      'preference-1',
      expect.objectContaining({ baseRevisionId: 'revision-2', baseVersion: 2 }),
      'renew',
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('round-trips typed subjects and requireEligible when superseding', async () => {
    mocks.supersede.mockResolvedValueOnce({ outcome: 'appended' });
    const { RoutingPreferenceControls } = await import('../RoutingPreferenceControls');
    await act(async () => root.render(<RoutingPreferenceControls revisions={[typedRevision]} onChanged={vi.fn()} />));
    const edit = [...container.querySelectorAll('button')].find((button) => button.textContent === '编辑');
    await act(async () => edit?.click());
    await act(async () =>
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );

    expect(mocks.supersede).toHaveBeenCalledWith(
      'preference-1',
      expect.objectContaining({
        appliesWhen: typedRevision.appliesWhen,
        prefer: typedRevision.prefer,
        over: typedRevision.over,
      }),
    );
  });

  it('reuses the same command id when a failed create is retried', async () => {
    mocks.create.mockRejectedValueOnce(new Error('网络断开')).mockResolvedValueOnce({ outcome: 'replayed' });
    const { RoutingPreferenceControls } = await import('../RoutingPreferenceControls');
    await act(async () => root.render(<RoutingPreferenceControls revisions={[]} onChanged={vi.fn()} />));
    const prefer = container.querySelector<HTMLInputElement>('[name="preference-prefer"]');
    const over = container.querySelector<HTMLInputElement>('[name="preference-over"]');
    const rationale = container.querySelector<HTMLInputElement>('[name="preference-rationale"]');
    if (!prefer || !over || !rationale) throw new Error('preference draft inputs were not rendered');
    act(() => {
      Simulate.change(prefer, { target: { value: 'opus5' } } as never);
      Simulate.change(over, { target: { value: 'codex-sol' } } as never);
      Simulate.change(rationale, { target: { value: '复杂终审' } } as never);
    });
    const form = container.querySelector('form');
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(mocks.create.mock.calls[0]?.[0].commandId).toBe(mocks.create.mock.calls[1]?.[0].commandId);
  });

  it('mints a new command id when the owner changes a failed draft', async () => {
    mocks.create.mockRejectedValueOnce(new Error('网络断开')).mockResolvedValueOnce({ outcome: 'appended' });
    const { RoutingPreferenceControls } = await import('../RoutingPreferenceControls');
    await act(async () => root.render(<RoutingPreferenceControls revisions={[]} onChanged={vi.fn()} />));
    const prefer = container.querySelector<HTMLInputElement>('[name="preference-prefer"]');
    const over = container.querySelector<HTMLInputElement>('[name="preference-over"]');
    const rationale = container.querySelector<HTMLInputElement>('[name="preference-rationale"]');
    if (!prefer || !over || !rationale) throw new Error('preference draft inputs were not rendered');
    act(() => {
      Simulate.change(prefer, { target: { value: 'opus5' } } as never);
      Simulate.change(over, { target: { value: 'codex-sol' } } as never);
      Simulate.change(rationale, { target: { value: '复杂终审' } } as never);
    });
    const form = container.querySelector('form');
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    act(() => Simulate.change(rationale, { target: { value: '架构终审' } } as never));
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(mocks.create.mock.calls[0]?.[0].commandId).not.toBe(mocks.create.mock.calls[1]?.[0].commandId);
  });

  it('refreshes canonical truth and exits a stale editor after a 409', async () => {
    const { RoutingContextCommandError } = await import('../routing-context-client');
    mocks.supersede.mockRejectedValueOnce(new RoutingContextCommandError('conflict', 409));
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const { RoutingPreferenceControls } = await import('../RoutingPreferenceControls');
    await act(async () =>
      root.render(<RoutingPreferenceControls revisions={[activeRevision]} onChanged={onChanged} />),
    );
    const edit = [...container.querySelectorAll('button')].find((button) => button.textContent === '编辑');
    await act(async () => edit?.click());
    await act(async () =>
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );

    expect(onChanged).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('已刷新最新版本');
    expect(container.textContent).toContain('新增偏好');
    expect(container.textContent).not.toContain('保存新版本');
  });
});
