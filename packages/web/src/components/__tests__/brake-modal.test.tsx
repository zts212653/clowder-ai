/**
 * F085 Phase 6 — BrakeModal gentle/hardcore UI branch tests (AC3/AC4/AC6).
 *
 * The API tests cover mode values and Redis writes, but not the actual UI
 * contract: gentle = one-click dismiss (AC4), hardcore = typed check-in with
 * escalating bypass (AC3, the legacy commitment-device behavior).
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrakeStore } from '@/stores/brakeStore';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// TTS touches audio/network — irrelevant to the mode branch
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ synthesize: vi.fn(), state: 'idle' }),
}));

// Cat name resolution pulls in the member registry — irrelevant to the branch
vi.mock('@/hooks/useCatNameResolver', () => ({
  useCatNameResolver: () => (catId: string) => catId,
}));

// CatAvatar fires async image-loading effects — irrelevant to the mode branch
// and noisy (act(...) warnings) under createRoot
vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => null,
}));

import { BrakeModal } from '../BrakeModal';

const INITIAL = useBrakeStore.getState();

function showTrigger(mode?: 'gentle' | 'hardcore') {
  useBrakeStore.getState().show({
    level: 1,
    activeMinutes: 95,
    nightMode: false,
    timestamp: 1_000,
    ...(mode !== undefined ? { mode } : {}),
  });
}

describe('BrakeModal mode branch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    useBrakeStore.setState(INITIAL, true);
    mockApiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = () => {
    act(() => {
      root.render(React.createElement(BrakeModal));
    });
  };

  it('gentle mode renders one-click dismiss and no typed check-in (AC4)', () => {
    act(() => showTrigger('gentle'));
    render();

    const dismiss = container.querySelector('button');
    expect(dismiss?.textContent).toContain('知道了，我会注意的');
    expect(container.textContent).not.toContain('立刻休息');
    expect(container.textContent).not.toContain('我有紧急情况');
  });

  it('hardcore mode renders typed check-in options and no one-click dismiss (AC3)', () => {
    act(() => showTrigger('hardcore'));
    render();

    expect(container.textContent).toContain('立刻休息（5 分钟）');
    expect(container.textContent).toContain('收尾（10 分钟）');
    expect(container.textContent).toContain('我有紧急情况（需要理由）');
    expect(container.textContent).not.toContain('知道了，我会注意的');
  });

  it('missing mode (legacy API) renders the hardcore branch', () => {
    act(() => showTrigger());
    render();

    expect(container.textContent).toContain('立刻休息（5 分钟）');
    expect(container.textContent).not.toContain('知道了，我会注意的');
  });

  it('gentle dismiss posts rest check-in and hides the modal (AC4)', async () => {
    mockApiFetch.mockResolvedValue({ json: async () => ({ ok: true, nextCheckMinutes: 0 }) });
    act(() => showTrigger('gentle'));
    render();

    const dismiss = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('知道了，我会注意的'),
    );
    expect(dismiss).toBeDefined();
    await act(async () => {
      dismiss?.click();
    });

    const checkinCall = mockApiFetch.mock.calls.find((c) => c[0] === '/api/brake/checkin');
    expect(checkinCall).toBeDefined();
    const body = JSON.parse((checkinCall?.[1] as { body: string }).body);
    expect(body.choice).toBe('rest');
    expect(useBrakeStore.getState().visible).toBe(false);
  });
});
