import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCoCreatorConfigCacheForTest, useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { getMentionRe, getMentionToCat, resetMentionDataForTest } from '@/lib/mention-highlight';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

function CoCreatorProbe() {
  const coCreator = useCoCreatorConfig();
  return React.createElement('span', null, coCreator.name);
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useCoCreatorConfig', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    resetCoCreatorConfigCacheForTest();
    resetMentionDataForTest();
    mockApiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCoCreatorConfigCacheForTest();
    resetMentionDataForTest();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('retries fetching co-creator config after a transient /api/config failure on the next mount', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: false } as Response);

    act(() => {
      root.render(React.createElement(CoCreatorProbe));
    });
    await act(async () => {
      await flushEffects();
    });

    expect(container.textContent).toBe('ME');
    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(container);

    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        config: {
          coCreator: {
            name: 'Recovered Owner',
            aliases: ['Co-worker'],
            mentionPatterns: ['@owner'],
            color: {
              primary: '#123456',
              secondary: '#abcdef',
            },
          },
        },
      }),
    } as unknown as Response);

    act(() => {
      root.render(React.createElement(CoCreatorProbe));
    });
    await act(async () => {
      await flushEffects();
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('Recovered Owner');
  });

  it('refreshes owner mention parsing when custom owner handles are loaded', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        config: {
          coCreator: {
            name: 'Lang',
            aliases: ['Co-worker'],
            mentionPatterns: ['@lang', '@owner'],
            color: {
              primary: '#123456',
              secondary: '#abcdef',
            },
          },
        },
      }),
    } as unknown as Response);

    act(() => {
      root.render(React.createElement(CoCreatorProbe));
    });
    await act(async () => {
      await flushEffects();
    });

    expect(container.textContent).toBe('Lang');
    expect(getMentionToCat().lang).toBe('__co-creator__');
    const re = getMentionRe();
    re.lastIndex = 0;
    expect(re.exec('请 @lang 看一下')).not.toBeNull();
  });
});
