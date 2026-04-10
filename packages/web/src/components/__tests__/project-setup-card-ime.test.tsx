import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSetupCard } from '@/components/ProjectSetupCard';

const mockApiFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

vi.mock('@/utils/api-client', () => ({
  apiFetch: () => mockApiFetch(),
}));

describe('ProjectSetupCard IME guard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('prevents Enter default and does not submit clone while composing', async () => {
    const onComplete = vi.fn();

    await act(async () => {
      root.render(
        <ProjectSetupCard projectPath="/tmp/demo" isEmptyDir isGitRepo={false} gitAvailable onComplete={onComplete} />,
      );
    });

    const input = container.querySelector('input[placeholder="https:// 或 git@..."]') as HTMLInputElement | null;
    if (!input) throw new Error('Missing clone url input');

    await act(async () => {
      input.value = 'https://example.com/repo.git';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(enter);
    });

    expect(enter.defaultPrevented).toBe(true);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
