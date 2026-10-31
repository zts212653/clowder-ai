import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCapabilityTipEvent } from '@/lib/capabilityTipEvents';
import { openFeatureDemoTrial } from '@/lib/feature-demo-trial';
import { useFeatureDemoStore } from '@/stores/featureDemoStore';
import { CapabilityTipStrip } from '../CapabilityTipStrip';
import { FeatureDemoHost } from '../FeatureDemoHost';

vi.mock('@/lib/capability-tips.seed.json', async (original) => {
  const inventory = await original<{ default: { id: string }[] }>();
  return { default: inventory.default.filter((tip) => tip.id === 'capability-propose-thread') };
});
vi.mock('@/lib/feature-demo-trial', () => ({ openFeatureDemoTrial: vi.fn(async () => true) }));
vi.mock('@/lib/capabilityTipEvents', () => ({ recordCapabilityTipEvent: vi.fn(() => true) }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  useFeatureDemoStore.setState({ session: null });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('F331 feature demo entry', () => {
  it('offers a demo alongside the existing learn-more action', async () => {
    await act(async () =>
      root.render(<CapabilityTipStrip surface="pending_bubble" contexts={['thinking']} firstDelayMs={0} />),
    );
    expect(container.textContent).toContain('观看演示');
    expect(container.textContent).toContain('了解更多');
    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(labels).toEqual(['观看演示', '了解更多']);
  });

  it('keeps playback when the waiting row disappears, retries errors, and opens only an explicit draft', async () => {
    const view = (waiting: boolean) => (
      <>
        {waiting && <CapabilityTipStrip surface="pending_bubble" contexts={['thinking']} firstDelayMs={0} />}
        <FeatureDemoHost />
      </>
    );
    await act(async () => root.render(view(true)));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="capability-tip-watch-demo"]')?.click());
    const video = document.querySelector('video');
    expect(video?.getAttribute('src')).toContain('conversation-proposals-v1.zh.mp4');
    await act(async () => root.render(view(false)));
    expect(document.querySelector('video')).toBe(video);
    act(() => video?.dispatchEvent(new Event('error')));
    expect(document.body.textContent).toContain('重试播放');
    const button = (text: string) => [...document.querySelectorAll('button')].find((node) => node.textContent === text);
    act(() => button('重试播放')?.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('video')).not.toBe(video);
    await act(async () => button('立即试用')?.click());
    expect(document.querySelector('dialog')).toBeNull();
    expect(openFeatureDemoTrial).toHaveBeenCalledWith(
      expect.stringContaining('提议创建新对话'),
      expect.any(AbortSignal),
    );
  });

  it('counts completion once only after the end with sufficient actually played media, never after seeking', async () => {
    act(() =>
      useFeatureDemoStore.getState().open({
        demoId: 'conversation-proposals-v1',
        tipId: 'capability-propose-thread',
        context: 'thinking',
        surface: 'pending_bubble',
      }),
    );
    await act(async () => root.render(<FeatureDemoHost />));
    const video = document.querySelector('video');
    act(() => video?.dispatchEvent(new Event('ended')));
    expect(
      vi.mocked(recordCapabilityTipEvent).mock.calls.some(([event]) => event.event === 'capability_tip_demo_completed'),
    ).toBe(false);
    Object.defineProperty(video, 'played', { value: { length: 1, start: () => 0, end: () => 48.5 } });
    act(() => {
      video?.dispatchEvent(new Event('ended'));
      video?.dispatchEvent(new Event('ended'));
    });
    expect(
      vi
        .mocked(recordCapabilityTipEvent)
        .mock.calls.filter(([event]) => event.event === 'capability_tip_demo_completed'),
    ).toHaveLength(1);
  });
});
