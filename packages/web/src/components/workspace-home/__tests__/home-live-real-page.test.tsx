// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { HomeLiveCard } from '../HomeLiveCard';
import { live, NOW, seed } from './home-fixtures';

const cancel = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useActiveExecutionProjection', () => ({ cancelProjectedExecution: cancel }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ displayName: 'Sol 6.1' }) }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span data-testid="avatar" /> }));
let host: HTMLDivElement;
let root: Root;
const title = 'F322 公共工作台：一条很长但仍然需要完整看清的真实对话标题';
const execution = { ...live('codex61-sol', 'thread-home-source', title, 'run-live'), startedAt: NOW - 90_000 };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  writeShellLanguage('zh');
  useActiveExecutionStore.getState().reset();
  seed([execution]);
  cancel.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useActiveExecutionStore.getState().reset();
});

it('updates the single live execution clock while leaving the original execution projection intact', () => {
  act(() => root.render(<HomeLiveCard threadId="thread-elsewhere" />));
  const link = host.querySelector<HTMLButtonElement>('[data-testid="workspace-open-running-object"]');
  expect(link?.textContent).toContain('1:30');
  act(() => vi.advanceTimersByTime(60_000));
  expect(link?.textContent).toContain('2:30');
  expect(useActiveExecutionStore.getState().executionsByKey[activeExecutionKey(execution)]).toBe(execution);
});

it('makes the whole text-bearing row the original detail button with name, clock and separate title', () => {
  act(() => root.render(<HomeLiveCard threadId="thread-elsewhere" onSelectExecution={vi.fn()} />));
  const link = host.querySelector<HTMLButtonElement>('[data-testid="workspace-open-running-object"]');
  expect(link?.textContent).toContain('Sol 6.1');
  expect(link?.textContent).toContain('1:30');
  expect(link?.textContent).toContain(title);
  expect(link?.textContent).not.toContain('打开对话');
  expect(link?.querySelector('button')).toBeNull();
});

it('returns the whole row to its original conversation and keeps trajectory and confirmed Stop separate', () => {
  const details = vi.fn();
  act(() => root.render(<HomeLiveCard threadId="thread-elsewhere" onSelectExecution={details} />));
  const open = host.querySelector<HTMLAnchorElement>('[data-testid="workspace-open-running-object"]');
  expect(open?.getAttribute('href')).toBe('/thread/thread-home-source');
  const trajectory = host.querySelector<HTMLButtonElement>('button[data-testid="home-execution-trajectory"]');
  expect(trajectory?.getAttribute('aria-label')).toContain('轨迹');
  act(() => trajectory?.click());
  expect(details).toHaveBeenCalledWith(execution);
  const stop = host.querySelector<HTMLButtonElement>('button.home-stop');
  expect(stop?.getAttribute('aria-label')).toContain('停止');
  act(() => stop?.click());
  expect(cancel).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

it('marks the current conversation without disabling its native link or losing pending cancellation truth', () => {
  useActiveExecutionStore.setState({ cancelPendingByKey: { [activeExecutionKey(execution)]: true } });
  act(() => root.render(<HomeLiveCard threadId="thread-home-source" onSelectExecution={vi.fn()} />));
  expect(host.querySelector('[data-testid="workspace-open-running-object"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="workspace-running-here"]')?.textContent).toBe('当前对话 · ');
  expect(host.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(1);
  expect(host.querySelector<HTMLButtonElement>('button.home-stop')?.disabled).toBe(true);
  expect(cancel).not.toHaveBeenCalled();
});

it('a replacement during Stop confirmation cannot be canceled by the old confirmation', async () => {
  act(() => root.render(<HomeLiveCard threadId="thread-home-source" onSelectExecution={vi.fn()} />));
  act(() => host.querySelector<HTMLButtonElement>('button.home-stop')?.click());
  const confirm = [
    ...(document.querySelector('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('button') ?? []),
  ].find((button) => button.textContent === '停止');
  expect(confirm).toBeDefined();
  await act(async () => {
    seed([{ ...execution, startedAt: execution.startedAt + 1000 }]);
  });
  await act(async () => {
    confirm?.click();
  });
  expect(cancel).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('confirming Stop submits the exact selected execution once and keeps another cat visible', async () => {
  const other = live('codex-sol', 'thread-home-source', title, 'other-live');
  seed([execution, other]);
  act(() => root.render(<HomeLiveCard threadId="thread-home-source" onSelectExecution={vi.fn()} />));
  act(() => host.querySelector<HTMLButtonElement>('button.home-stop')?.click());
  const confirm = [
    ...(document.querySelector('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('button') ?? []),
  ].find((button) => button.textContent === '停止');
  await act(async () => confirm?.click());
  expect(cancel).toHaveBeenCalledExactlyOnceWith(execution);
  expect(useActiveExecutionStore.getState().executionsByKey[activeExecutionKey(other)]).toBe(other);
});
