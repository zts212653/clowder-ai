import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEMO_EVENTS } from '../../onboarding-demo/demo-story';
import { GuidedOnboarding } from '../../onboarding-demo/GuidedOnboarding';

let root: Root, host: HTMLDivElement;
const close = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('No API should be used by demo'))),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const button = (text: string) => {
  const element = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
};
const mount = () => act(() => root.render(<GuidedOnboarding open storageScope="demo-user" onClose={close} />));
const tick = async () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });

it('shows thinking then a partial response, and delays preview until the response finishes', async () => {
  localStorage.setItem('cat-cafe:scripted-onboarding:v1:demo-user', JSON.stringify({ version: 1, index: 3 }));
  await mount();
  expect(document.querySelector('[data-demo-phase="thinking"]')).not.toBeNull();
  expect(document.querySelector('[data-preview-stage="design"]')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1300));
  const text = document.querySelector('[data-demo-phase="typing"]')?.textContent;
  expect(text?.length).toBeGreaterThan(0);
  expect(text).not.toContain(DEMO_EVENTS[3].text);
  act(() => button('暂停').click());
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(document.querySelector('[data-demo-phase="typing"]')?.textContent).toBe(text);
  act(() => button('继续').click());
  await act(async () => vi.advanceTimersByTimeAsync(2200));
  expect([...document.querySelectorAll('[data-demo-phase="complete"]')].at(-1)?.textContent).toContain(
    DEMO_EVENTS[3].text,
  );
  expect(document.querySelector('[data-preview-stage="design"]')).not.toBeNull();
});

const acknowledge = async (source: Window | null | undefined, stage = 'final') => {
  await act(async () =>
    window.dispatchEvent(
      new window.MessageEvent('message', {
        source,
        data: { type: 'clowder-onboarding-ready', version: 1 },
      }),
    ),
  );
  await act(async () =>
    window.dispatchEvent(
      new window.MessageEvent('message', {
        source,
        data: { type: 'clowder-onboarding-stage-ready', version: 1, stage },
      }),
    ),
  );
};

it('starts playing as soon as the demo opens without another start action', async () => {
  await mount();
  expect(document.body.textContent).toContain('1 / 9');
  expect([...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '开始引导')).toBe(false);
  expect(button('暂停')).toBeDefined();
  await tick();
  expect(document.body.textContent).toContain('2 / 9');
});

it('automatically replays when the user opens an already completed demo', async () => {
  localStorage.setItem('cat-cafe:scripted-onboarding:v1:demo-user', JSON.stringify({ version: 1, index: 9 }));
  await mount();
  expect(document.body.textContent).toContain('1 / 9');
  expect(button('暂停')).toBeDefined();
});

it('keeps the same browser beside the conversation from design through delivery', async () => {
  await mount();
  const frame = document.querySelector('iframe');
  expect(frame).not.toBeNull();
  for (let i = 0; i < 16; i++) {
    await tick();
    expect(document.querySelector('iframe')).toBe(frame);
    expect(document.querySelector('[data-testid="demo-transcript"]')?.closest('[hidden], .hidden')).toBeNull();
  }
  expect(document.querySelector('[data-preview-stage="final"]')).not.toBeNull();
  expect([...document.querySelectorAll('button')].some((b) => b.textContent === '回看协作过程')).toBe(false);
});

it('automates all handoffs without clients or API calls and opens a working deliverable', async () => {
  await mount();
  for (let i = 0; i < 16; i++) await tick();
  expect(document.body.textContent).toContain('审查通过');
  expect(document.body.textContent).toContain('已修正');
  expect(document.querySelectorAll('[data-demo-handoff]').length).toBeGreaterThanOrEqual(6);
  const frame = document.querySelector('iframe');
  expect(frame?.title).toBe('今天待办 · 演示成果');
  expect(fetch).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('成果已就绪');
  await acknowledge(frame?.contentWindow);
  expect(document.querySelector('a')?.getAttribute('href')).toBe('/settings?s=members&view=setup');
  expect(document.querySelector('a')?.textContent).toContain('创建我的猫猫');
});

it('ignores unrelated frames, offers retry on timeout, and accepts the current frame only', async () => {
  localStorage.setItem('cat-cafe:scripted-onboarding:v1:demo-user', JSON.stringify({ version: 1, index: 8 }));
  await mount();
  await acknowledge(window);
  expect(document.body.textContent).not.toContain('成果已就绪');
  await tick();
  expect(document.body.textContent).toContain('成果暂时没有打开');
  const oldFrame = document.querySelector('iframe')?.contentWindow;
  act(() => button('重新打开').click());
  expect(document.body.textContent).toContain('正在打开成果');
  await acknowledge(oldFrame);
  expect(document.body.textContent).not.toContain('成果已就绪');
  await acknowledge(document.querySelector('iframe')?.contentWindow);
  expect(document.querySelector('a')?.textContent).toContain('创建我的猫猫');
  expect(fetch).not.toHaveBeenCalled();
});

it('recovers corrupt bookmarks and does not skip steps under StrictMode', async () => {
  localStorage.setItem('cat-cafe:scripted-onboarding:v1:demo-user', '{broken');
  act(() =>
    root.render(
      <StrictMode>
        <GuidedOnboarding open storageScope="demo-user" onClose={close} />
      </StrictMode>,
    ),
  );
  expect(document.body.textContent).toContain('1 / 9');
  await tick();
  expect(document.body.textContent).toContain('2 / 9');
  act(() => root.render(<GuidedOnboarding open storageScope="another-demo" onClose={close} />));
  expect(button('暂停')).toBeDefined();
  expect(document.body.textContent).toContain('1 / 9');
  expect(fetch).not.toHaveBeenCalled();
});

it('works without browser storage and cleans up timers on close', async () => {
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  await mount();
  await tick();
  act(() => root.render(<GuidedOnboarding open={false} storageScope="demo-user" onClose={close} />));
  await tick();
  expect(vi.getTimerCount()).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it('pauses the script and automatically continues from the same point after reopening', async () => {
  await mount();
  await tick();
  act(() => button('暂停').click());
  const before = document.querySelector('[data-testid="demo-transcript"]')?.textContent;
  await tick();
  expect(document.querySelector('[data-testid="demo-transcript"]')?.textContent).toBe(before);
  act(() => root.render(<GuidedOnboarding open={false} storageScope="demo-user" onClose={close} />));
  await mount();
  expect(button('暂停')).toBeDefined();
  expect(document.body.textContent).toContain('2 / 9');
  await tick();
  expect(document.body.textContent).toContain('3 / 9');
  expect(fetch).not.toHaveBeenCalled();
});
