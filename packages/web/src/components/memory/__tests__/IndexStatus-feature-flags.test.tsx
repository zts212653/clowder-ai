/**
 * Bug: 记忆 → 索引状态 → 功能开关 rendered EVERY evidence-category on/off var as a
 * clickable toggle, ignoring the registry's `runtimeEditable` gate. Vars without
 * runtimeEditable (EMBED_MODE, F102_ABSTRACTIVE, …) got PATCH 400 "not editable
 * from Hub", and cycleEnvVar never checked res.ok — so the switch silently flipped
 * back. Co-creator saw "开关无法点击切换".
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/utils/api-client';
import { IndexStatus } from '../IndexStatus';

const STATUS_PAYLOAD = { backend: 'sqlite', healthy: true, docs_count: 1, vectors_count: 0 };

function mkVar(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    defaultValue: 'off',
    description: `desc for ${name}`,
    category: 'evidence',
    sensitive: false,
    currentValue: 'off',
    ...extra,
  };
}

/** env-summary containing the two shape families that matter:
 *  - F163_* tri-state with runtimeEditable: true → must stay clickable
 *  - F102_ABSTRACTIVE plain on/off WITHOUT runtimeEditable → must be read-only
 *  - EMBED_MODE tri-state WITHOUT runtimeEditable → must be read-only
 */
const ENV_SUMMARY = {
  variables: [
    mkVar('F163_AUTHORITY_BOOST', {
      allowedValues: ['off', 'shadow', 'on'],
      runtimeEditable: true,
    }),
    mkVar('F102_RUNTIME_TOGGLE', { runtimeEditable: true }), // hypothetical editable on/off switch
    mkVar('F102_ABSTRACTIVE'), // no runtimeEditable → read-only
    mkVar('EMBED_MODE', { allowedValues: ['off', 'shadow', 'on'] }), // read-only tri-state
  ],
};

describe('IndexStatus feature flags (runtimeEditable gate)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockFetch = apiFetch as ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function mockGetOnce() {
    mockFetch.mockImplementation((path: string) => {
      if (path === '/api/evidence/status') return Promise.resolve({ ok: true, json: async () => STATUS_PAYLOAD });
      if (path === '/api/config/env-summary') return Promise.resolve({ ok: true, json: async () => ENV_SUMMARY });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  }

  async function renderAndWait() {
    mockGetOnce();
    await act(async () => {
      root.render(<IndexStatus />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders runtimeEditable toggles as clickable controls', async () => {
    await renderAndWait();

    const cycle = container.querySelector('[data-testid="feature-cycle-F163_AUTHORITY_BOOST"]');
    expect(cycle).not.toBeNull();
    expect(cycle!.tagName).toBe('BUTTON');
    // plain on/off editable var → switch button
    const toggle = container.querySelector('[data-testid="feature-toggle-F102_RUNTIME_TOGGLE"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.tagName).toBe('BUTTON');
  });

  it('renders non-editable toggles as read-only badges, not clickable buttons', async () => {
    await renderAndWait();

    // plain on/off without runtimeEditable
    expect(container.querySelector('[data-testid="feature-toggle-F102_ABSTRACTIVE"]')).toBeNull();
    const ro = container.querySelector('[data-testid="feature-readonly-F102_ABSTRACTIVE"]');
    expect(ro).not.toBeNull();
    expect(ro!.tagName).not.toBe('BUTTON');
    expect(ro!.textContent).toContain('off');

    // tri-state without runtimeEditable is also read-only (no cycle button)
    expect(container.querySelector('[data-testid="feature-cycle-EMBED_MODE"]')).toBeNull();
    const roMode = container.querySelector('[data-testid="feature-readonly-EMBED_MODE"]');
    expect(roMode).not.toBeNull();
    expect(roMode!.tagName).not.toBe('BUTTON');
  });

  it('cycles an editable var via PATCH and reflects the new value', async () => {
    let patchBody: unknown = null;
    mockFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/evidence/status') return Promise.resolve({ ok: true, json: async () => STATUS_PAYLOAD });
      if (path === '/api/config/env-summary') {
        const vars =
          patchBody != null
            ? ENV_SUMMARY.variables.map((v) =>
                v.name === 'F163_AUTHORITY_BOOST' ? { ...v, currentValue: 'shadow' } : v,
              )
            : ENV_SUMMARY.variables;
        return Promise.resolve({ ok: true, json: async () => ({ variables: vars }) });
      }
      if (path === '/api/config/env') {
        patchBody = init?.body ? JSON.parse(String(init.body)) : null;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await act(async () => {
      root.render(<IndexStatus />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const btn = container.querySelector('[data-testid="feature-cycle-F163_AUTHORITY_BOOST"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(patchBody).toEqual({
      updates: [{ name: 'F163_AUTHORITY_BOOST', value: 'shadow' }],
    });
    expect(container.querySelector('[data-testid="feature-cycle-F163_AUTHORITY_BOOST"]')!.textContent).toBe('shadow');
  });

  it('surfaces a PATCH failure inline instead of silently reverting', async () => {
    mockFetch.mockImplementation((path: string) => {
      if (path === '/api/evidence/status') return Promise.resolve({ ok: true, json: async () => STATUS_PAYLOAD });
      if (path === '/api/config/env-summary') return Promise.resolve({ ok: true, json: async () => ENV_SUMMARY });
      if (path === '/api/config/env')
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ error: "Env var 'F163_AUTHORITY_BOOST' is not editable from Hub" }),
        });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await act(async () => {
      root.render(<IndexStatus />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const btn = container.querySelector('[data-testid="feature-cycle-F163_AUTHORITY_BOOST"]') as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const err = container.querySelector('[data-testid="env-update-error"]');
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain('not editable from Hub');
    // value did not change
    expect(container.querySelector('[data-testid="feature-cycle-F163_AUTHORITY_BOOST"]')!.textContent).toBe('off');
  });
});
