// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MountRulesPanel } from '../MountRulesPanel';

const apiFetch = vi.fn();

vi.mock('../../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

function rulesFor(label: string) {
  return {
    version: 1,
    mountPoints: {
      claude: { enabled: true, path: `.claude/${label}` },
      codex: { enabled: true, path: '.codex/skills' },
      gemini: { enabled: true, path: '.gemini/skills' },
      kimi: { enabled: true, path: '.kimi/skills' },
    },
    customPaths: [],
  };
}

describe('MountRulesPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            projectRoot: url.includes('project-b') ? '/tmp/project-b' : '/tmp/project-a',
            rules: url.includes('project-b') ? rulesFor('project-b') : rulesFor('project-a'),
          }),
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    apiFetch.mockReset();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('refetches mount rules when the selected project changes while open', async () => {
    act(() => {
      root.render(<MountRulesPanel projectPath="/tmp/project-a" />);
    });

    const toggleButton = container.querySelector('button');
    expect(toggleButton).toBeTruthy();
    await act(async () => {
      (toggleButton as HTMLButtonElement).click();
    });
    await flush();
    expect(apiFetch).toHaveBeenCalledWith('/api/mount-rules?projectPath=%2Ftmp%2Fproject-a');

    act(() => {
      root.render(<MountRulesPanel projectPath="/tmp/project-b" />);
    });
    await flush();

    expect(apiFetch).toHaveBeenCalledWith('/api/mount-rules?projectPath=%2Ftmp%2Fproject-b');
    expect(container.textContent).toContain('.claude/project-b');
  });
});
