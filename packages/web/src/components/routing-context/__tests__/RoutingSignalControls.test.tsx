import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mark: vi.fn() }));
vi.mock('../routing-context-client', () => ({
  markRoutingSignal: (...args: unknown[]) => mocks.mark(...args),
  closeRoutingSignal: vi.fn(),
}));

describe('F293 RoutingSignalControls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.mark.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows blast radius and retains the draft after a failed save', async () => {
    mocks.mark.mockRejectedValueOnce(new Error('写入失败'));
    const { RoutingSignalControls } = await import('../RoutingSignalControls');
    await act(async () =>
      root.render(
        <RoutingSignalControls
          subjectRef={{ type: 'cat', catId: 'codex-sol' }}
          affectedCatIds={['codex-sol']}
          signalEvents={[]}
          onChanged={vi.fn()}
        />,
      ),
    );
    const reason = container.querySelector<HTMLInputElement>('[name="signal-reason"]');
    const form = container.querySelector<HTMLFormElement>('form');
    if (!reason) throw new Error('signal reason input was not rendered');
    act(() => Simulate.change(reason, { target: { value: 'owner-maintenance' } } as never));
    expect(container.textContent).toContain('影响 1 位成员：codex-sol');
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(container.textContent).toContain('写入失败');
    expect(reason?.value).toBe('owner-maintenance');
  });

  it('reuses one command id after an uncertain failure', async () => {
    mocks.mark.mockRejectedValueOnce(new Error('网络断开')).mockResolvedValueOnce({ outcome: 'replayed' });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const { RoutingSignalControls } = await import('../RoutingSignalControls');
    await act(async () =>
      root.render(
        <RoutingSignalControls
          subjectRef={{ type: 'cat', catId: 'codex-sol' }}
          affectedCatIds={['codex-sol']}
          signalEvents={[]}
          onChanged={onChanged}
        />,
      ),
    );
    const form = container.querySelector<HTMLFormElement>('form');
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(mocks.mark).toHaveBeenCalledTimes(2);
    expect(mocks.mark.mock.calls[0]?.[0].commandId).toBe(mocks.mark.mock.calls[1]?.[0].commandId);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('refetches canonical truth only after a successful append', async () => {
    mocks.mark.mockResolvedValueOnce({ outcome: 'appended' });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const { RoutingSignalControls } = await import('../RoutingSignalControls');
    await act(async () =>
      root.render(
        <RoutingSignalControls
          subjectRef={{ type: 'provider', providerId: 'openai' }}
          affectedCatIds={['codex-sol']}
          signalEvents={[]}
          onChanged={onChanged}
        />,
      ),
    );
    const reason = container.querySelector<HTMLInputElement>('[name="signal-reason"]');
    const form = container.querySelector<HTMLFormElement>('form');
    if (!reason) throw new Error('signal reason input was not rendered');
    act(() => Simulate.change(reason, { target: { value: 'quota-window' } } as never));
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(mocks.mark).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('labels an elapsed assertion as expired instead of presenting it as current', async () => {
    const { RoutingSignalControls } = await import('../RoutingSignalControls');
    await act(async () =>
      root.render(
        <RoutingSignalControls
          subjectRef={{ type: 'cat', catId: 'codex-sol' }}
          affectedCatIds={['codex-sol']}
          signalEvents={[
            {
              v: 1,
              eventId: 'signal-expired',
              commandId: 'command-expired',
              ownerId: 'owner-1',
              subjectRef: { type: 'cat', catId: 'codex-sol' },
              reasonCode: 'owner-maintenance',
              source: 'manual_cvo',
              observedAt: 1,
              validUntil: 2,
              evidenceRef: 'command:command-expired',
              eventType: 'asserted',
              state: 'unavailable',
            },
          ]}
          onChanged={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('已过期（等待确认）');
    expect(container.textContent).not.toContain('unavailable · owner-maintenance');
  });
});
