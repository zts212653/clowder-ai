import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useGuideStore } from '@/stores/guideStore';
import { GuideOverlay } from '../GuideOverlay';

vi.mock('@/hooks/useGuideEngine', () => ({ useGuideEngine: () => {} }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(async () => new Response('{}')) }));
afterEach(() => {
  vi.unstubAllGlobals();
  useGuideStore.setState({ session: null });
});

it('keeps typing focus and leaves unrelated controls clickable throughout a non-blocking guide', async () => {
  const container = document.createElement('div');
  const input = document.createElement('input');
  input.dataset.guideId = 'chat.input';
  document.body.append(container, input);
  input.focus();
  const root = createRoot(container);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  try {
    useGuideStore.getState().startGuide(
      {
        id: 'first-run-entry',
        name: '入口提醒',
        nonBlocking: true,
        steps: [{ id: 'input', target: 'chat.input', tips: '直接发送即可开始', advance: 'next' }],
      },
      'thread-1',
    );
    await act(async () => {
      root.render(<GuideOverlay />);
    });
    await act(async () => {
      frames.splice(0).forEach((cb) => cb(0));
    });
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[data-guide-click-shield]')).toBeNull();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    await act(async () => {
      useGuideStore.getState().advanceStep();
    });
    expect(container.querySelector('.fixed.inset-0')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    input.remove();
  }
});
