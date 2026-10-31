import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GuidedOnboarding } from '../../onboarding-demo/GuidedOnboarding';
import { writeShellLanguage } from '../../shell/shell-language';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  localStorage.clear();
  writeShellLanguage('en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Demo must stay offline'))),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  writeShellLanguage('zh');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('shows the complete English demo, including its story and bundled result', async () => {
  act(() => root.render(<GuidedOnboarding open storageScope="english-demo" onClose={vi.fn()} />));
  expect(document.querySelector('h2')?.textContent).toBe('Watch the cats work together');
  expect(document.querySelector('[aria-label="Close guide"]')).not.toBeNull();
  expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Pause')).toBe(true);
  const frame = document.querySelector('iframe');
  expect(frame?.title).toBe('Today’s tasks · Demo result');
  expect(frame?.getAttribute('srcdoc')).toContain('<html lang="en">');
  for (let i = 0; i < 16; i++) await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(document.querySelector('iframe')).toBe(frame);
  expect(document.querySelectorAll('[data-demo-handoff]')).toHaveLength(6);
  expect(document.body.textContent).toContain('Review passed');
  expect(document.body.textContent).not.toMatch(/\p{Script=Han}/u);
  expect(fetch).not.toHaveBeenCalled();
});

it('changes language without restarting playback, unpausing it or replacing the result frame', async () => {
  localStorage.setItem('cat-cafe:scripted-onboarding:v1:english-demo', JSON.stringify({ version: 1, index: 3 }));
  act(() => root.render(<GuidedOnboarding open storageScope="english-demo" onClose={vi.fn()} />));
  const frame = document.querySelector('iframe');
  await act(async () => vi.advanceTimersByTimeAsync(1300));
  expect(document.querySelector('[data-demo-phase="typing"]')?.textContent).toContain('Use a clean daily checklist');
  const pause = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Pause');
  expect(pause).toBeDefined();
  act(() => pause?.click());
  act(() => writeShellLanguage('zh'));
  expect(document.querySelector('h2')?.textContent).toBe('看猫猫一起把事情做好');
  expect(document.body.textContent).toContain('4 / 9');
  expect(document.body.textContent).toContain('继续');
  expect(document.querySelector('iframe')).toBe(frame);
  act(() => writeShellLanguage('en'));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(document.body.textContent).toContain('4 / 9');
  expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Continue')).toBe(true);
  expect(document.querySelector('iframe')).toBe(frame);
});
