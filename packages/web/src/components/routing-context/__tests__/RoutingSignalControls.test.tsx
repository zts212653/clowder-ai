import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mark: vi.fn() }));
vi.mock('../routing-context-client', () => ({
  markRoutingSignal: (...args: unknown[]) => mocks.mark(...args),
  closeRoutingSignal: vi.fn(),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [{ id: 'codex-sol', displayName: '小太阳·砚砚' }] }),
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
    expect(container.textContent).toContain('影响 1 位成员：小太阳·砚砚');
    expect(container.textContent).not.toContain('影响 1 位成员：codex-sol');
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

  it('renders an open assertion with human labels instead of raw state and reason code', async () => {
    const { RoutingSignalControls } = await import('../RoutingSignalControls');
    await act(async () =>
      root.render(
        <RoutingSignalControls
          subjectRef={{ type: 'cat', catId: 'codex-sol' }}
          affectedCatIds={['codex-sol']}
          signalEvents={[
            {
              v: 1,
              eventId: 'signal-open',
              commandId: 'command-open',
              ownerId: 'owner-1',
              subjectRef: { type: 'cat', catId: 'codex-sol' },
              reasonCode: 'quota-window',
              source: 'manual_cvo',
              observedAt: Date.now(),
              validUntil: Date.now() + 3_600_000,
              evidenceRef: 'command:command-open',
              eventType: 'asserted',
              state: 'scarce',
            },
          ]}
          onChanged={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('供给偏紧');
    expect(container.textContent).toContain('额度周期限制');
    expect(container.textContent).not.toContain('scarce · quota-window');
    expect(container.textContent).toContain('原因');
    expect(container.textContent).not.toContain('原因代码');
  });

  it('keeps an unknown reason code as stored instead of inventing a translation', async () => {
    const { RoutingSignalControls } = await import('../RoutingSignalControls');
    await act(async () =>
      root.render(
        <RoutingSignalControls
          subjectRef={{ type: 'cat', catId: 'codex-sol' }}
          affectedCatIds={['codex-sol']}
          signalEvents={[
            {
              v: 1,
              eventId: 'signal-unknown',
              commandId: 'command-unknown',
              ownerId: 'owner-1',
              subjectRef: { type: 'cat', catId: 'codex-sol' },
              reasonCode: 'some-future-code',
              source: 'manual_cvo',
              observedAt: Date.now(),
              validUntil: Date.now() + 3_600_000,
              evidenceRef: 'command:command-unknown',
              eventType: 'asserted',
              state: 'unavailable',
            },
          ]}
          onChanged={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('暂不可用');
    expect(container.textContent).toContain('some-future-code');
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

  it('labels canonical dispatch failure codes in human language', async () => {
    const { RoutingSignalControls } = await import('../RoutingSignalControls');
    const assertion = (eventId: string, reasonCode: string) => ({
      v: 1 as const,
      eventId,
      commandId: `command-${eventId}`,
      ownerId: 'owner-1',
      subjectRef: { type: 'cat' as const, catId: 'codex-sol' },
      reasonCode,
      source: 'manual_cvo' as const,
      observedAt: Date.now(),
      validUntil: Date.now() + 3_600_000,
      evidenceRef: `command:command-${eventId}`,
      eventType: 'asserted' as const,
      state: 'unavailable' as const,
    });
    await act(async () =>
      root.render(
        <RoutingSignalControls
          subjectRef={{ type: 'cat', catId: 'codex-sol' }}
          affectedCatIds={['codex-sol']}
          signalEvents={[
            assertion('signal-quota', 'quota_exhausted'),
            assertion('signal-auth', 'authentication_rejected'),
            assertion('signal-unreachable', 'provider_unreachable'),
            assertion('signal-timeout', 'provider_timeout'),
          ]}
          onChanged={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('额度已用尽');
    expect(container.textContent).toContain('鉴权被拒绝');
    expect(container.textContent).toContain('服务暂时不可达');
    expect(container.textContent).toContain('服务响应超时');
    expect(container.textContent).not.toContain('quota_exhausted');
    expect(container.textContent).not.toContain('authentication_rejected');
    expect(container.textContent).not.toContain('provider_unreachable');
    expect(container.textContent).not.toContain('provider_timeout');
  });

  it('keeps members outside the catalog honest without leaking their raw cat id', async () => {
    const { RoutingSignalControls } = await import('../RoutingSignalControls');
    await act(async () =>
      root.render(
        <RoutingSignalControls
          subjectRef={{ type: 'cat', catId: 'codex-sol' }}
          affectedCatIds={['codex-sol', 'ghost-cat']}
          signalEvents={[]}
          onChanged={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('影响 2 位成员：小太阳·砚砚；1 位目录外成员');
    expect(container.textContent).not.toContain('ghost-cat');
  });
});
