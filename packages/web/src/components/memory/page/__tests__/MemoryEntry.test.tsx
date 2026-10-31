import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MemoryPage from '@/app/memory/page';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '@/components/shell/shell-presentation';

vi.mock('../../MemoryHub', () => ({
  MemoryHub: ({ initialReferrerThread }: { initialReferrerThread: string | null }) => (
    <div data-testid="legacy-memory" data-from={initialReferrerThread ?? ''} />
  ),
}));
vi.mock('../MemoryPagePreview', () => ({
  MemoryPagePreview: ({ tab, basePath }: { tab: string; basePath?: string }) => (
    <div data-testid="new-memory" data-tab={tab} data-base={basePath} />
  ),
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
  vi.unstubAllGlobals();
});
it('the persisted v2 sidebar destination /memory opens the four-tab page without a preview link', async () => {
  writeShellPresentation('v2');
  await act(() => root.render(<MemoryPage searchParams={{ from: 'thread-origin' }} />));
  expect(host.querySelector('[data-testid="legacy-memory"]')).toBeNull();
  expect(host.querySelector('[data-testid="new-memory"]')?.getAttribute('data-tab')).toBe('all');
  expect(host.querySelector('[data-testid="new-memory"]')?.getAttribute('data-base')).toBe('/memory');
});
it.each(['recall', 'brakes', 'library'])('v2 canonical deep link retains the %s tab', async (tab) => {
  writeShellPresentation('v2');
  await act(() => root.render(<MemoryPage searchParams={{ tab }} />));
  expect(host.querySelector('[data-testid="new-memory"]')?.getAttribute('data-tab')).toBe(tab);
});
it('classic keeps the exact legacy feed and referrer semantics, including after a presentation change', async () => {
  await act(() => root.render(<MemoryPage searchParams={{ from: 'thread-origin', tab: 'recall' }} />));
  expect(host.querySelector('[data-testid="legacy-memory"]')?.getAttribute('data-from')).toBe('thread-origin');
  expect(host.querySelector('[data-testid="new-memory"]')).toBeNull();
  await act(() => writeShellPresentation('v2'));
  expect(host.querySelector('[data-testid="new-memory"]')).not.toBeNull();
  await act(() => writeShellPresentation('classic'));
  expect(host.querySelector('[data-testid="legacy-memory"]')?.getAttribute('data-from')).toBe('thread-origin');
});
