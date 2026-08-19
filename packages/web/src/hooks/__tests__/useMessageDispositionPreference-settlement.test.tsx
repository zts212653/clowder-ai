import type { MessageDispositionPreferenceSnapshot } from '@cat-cafe/shared';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type MessageDispositionPreferenceController,
  useMessageDispositionPreference,
} from '@/hooks/useMessageDispositionPreference';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/api-client', () => ({ apiFetch: apiFetchMock }));

const SNAPSHOT: MessageDispositionPreferenceSnapshot = {
  productDefault: 'next_work',
  global: 'continue_current',
  thread: null,
  effective: 'continue_current',
  source: 'global',
  onboardingSeen: false,
};

describe('useMessageDispositionPreference settlement', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: MessageDispositionPreferenceController | null;

  function Probe() {
    latest = useMessageDispositionPreference('thread-1', false);
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    apiFetchMock.mockReset();
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    React.act(() => root.render(<Probe />));
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('settles loading after a successful preference save', async () => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(SNAPSHOT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    let saved = false;
    await React.act(async () => {
      saved = (await latest?.setPreference('global', 'continue_current')) ?? false;
    });

    expect(saved).toBe(true);
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.snapshot).toEqual(SNAPSHOT);
  });

  it.each([
    ['timeout', Object.assign(new Error('网络请求超时，请重试。'), { name: 'TimeoutError' }), '网络请求超时，请重试。'],
    ['caller abort', new DOMException('请求已取消', 'AbortError'), '偏好保存失败'],
    ['network failure', new Error('offline'), 'offline'],
  ])('settles loading and exposes a retryable error after %s', async (_label, cause, expectedMessage) => {
    apiFetchMock.mockRejectedValueOnce(cause);

    let saved = true;
    await React.act(async () => {
      saved = (await latest?.setPreference('global', 'continue_current')) ?? true;
    });

    expect(saved).toBe(false);
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBe(expectedMessage);
  });
});
