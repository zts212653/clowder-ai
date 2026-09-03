import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadGoalStateV1 } from '@/stores/chat-types';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { ThreadGoalSettingsContent } from '../ThreadGoalSettings';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('ThreadGoalSettingsContent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderGoal(getBody: { goal: ThreadGoalStateV1 | null } = { goal: null }) {
    apiFetch.mockResolvedValueOnce(response(getBody));
    await act(async () => root.render(<ThreadGoalSettingsContent threadId="thread-1" />));
  }

  it('offers a visible set journey and explains durable recovery when native sync is unavailable', async () => {
    await renderGoal();
    apiFetch.mockResolvedValueOnce(
      response(
        {
          goal: {
            v: 1,
            intent: 'set',
            objective: 'Ship Phase C',
            status: 'active',
            tokenBudget: null,
            revision: 1,
            updatedAt: 100,
            sync: { state: 'unavailable', source: 'cat_cafe', reason: 'provider_sync_failed' },
          },
          native: { state: 'unavailable' },
        },
        202,
      ),
    );
    const input = container.querySelector<HTMLInputElement>('textarea[name="objective"]');
    expect(input).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (input) valueSetter?.call(input, 'Ship Phase C');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(apiFetch).toHaveBeenLastCalledWith('/api/threads/thread-1/goal', expect.objectContaining({ method: 'PUT' }));
    const init = apiFetch.mock.calls.at(-1)?.[1] as RequestInit;
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(container.textContent).toContain('已经保存在这个对话里');
    expect(container.textContent).toContain('重试同步');
  });

  it('restores a saved goal and exposes refresh and clear without slash commands', async () => {
    await renderGoal({
      goal: {
        v: 1,
        intent: 'set',
        objective: 'Recovered goal',
        status: 'paused',
        tokenBudget: 8_000,
        revision: 2,
        updatedAt: 100,
        sync: { state: 'synced', source: 'codex_app_server', catId: 'codex' },
      },
    });
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Recovered goal');
    expect(container.textContent).toContain('已同步到 Codex 原生目标');
    expect(container.textContent).toContain('从 Codex 刷新');
    expect(container.textContent).toContain('清除目标');
  });

  it('requires the owner to select a native cat when the thread has multiple capable sessions', async () => {
    await renderGoal({ goal: null, nativeTargets: [{ catId: 'codex' }, { catId: 'codex-terra' }] } as never);
    const selector = container.querySelector<HTMLSelectElement>('select[name="goalCatId"]');
    expect(selector).not.toBeNull();
    act(() => {
      const textSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      const input = container.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
      if (input) textSetter?.call(input, 'Ship selected session');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      if (selector) selectSetter?.call(selector, 'codex-terra');
      selector?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    apiFetch.mockResolvedValueOnce(response({ goal: null }, 202));
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    const body = JSON.parse(String((apiFetch.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(body.catId).toBe('codex-terra');
  });
});
