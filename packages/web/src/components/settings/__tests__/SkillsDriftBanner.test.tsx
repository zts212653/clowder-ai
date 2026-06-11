// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsDriftBanner } from '../SkillsDriftBanner';

const apiFetch = vi.fn();

vi.mock('../../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

function driftResponse(projectPath: string) {
  return {
    result: {
      newSkills: [],
      conflicts: [
        {
          skill: 'tdd',
          kind: 'directory',
          provider: 'claude',
        },
      ],
      stale: [],
      driftHash: `hash-${projectPath}`,
      isIgnored: false,
    },
    projectRoot: projectPath,
  };
}

describe('SkillsDriftBanner', () => {
  let container: HTMLDivElement;
  let root: Root;
  const syncBodies: Array<Record<string, unknown>> = [];

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    syncBodies.length = 0;
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/skills/drift-check') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { projectPath?: string };
        return {
          ok: true,
          json: async () => driftResponse(body.projectPath ?? ''),
        };
      }
      if (url === '/api/skills/drift-resolve') {
        syncBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          ok: true,
          text: async () => '',
          json: async () => ({}),
        };
      }
      throw new Error(`Unexpected apiFetch path: ${url}`);
    });
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

  it('clears destructive conflict choices when switching projects', async () => {
    act(() => {
      root.render(<SkillsDriftBanner projectPath="/tmp/project-a" />);
    });
    await flush();

    const toggleButton = container.querySelector('button');
    expect(toggleButton).toBeTruthy();
    await act(async () => {
      (toggleButton as HTMLButtonElement).click();
    });

    const overrideInput = Array.from(container.querySelectorAll('input[type="radio"]')).at(1) as HTMLInputElement;
    expect(overrideInput).toBeTruthy();
    await act(async () => {
      overrideInput.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(overrideInput.checked).toBe(true);

    act(() => {
      root.render(<SkillsDriftBanner projectPath="/tmp/project-b" />);
    });
    await flush();

    const syncButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('立即同步'),
    );
    expect(syncButton).toBeTruthy();
    await act(async () => {
      (syncButton as HTMLButtonElement).click();
    });

    expect(syncBodies.at(-1)).toMatchObject({
      action: 'sync',
      projectPath: '/tmp/project-b',
    });
    expect(syncBodies.at(-1)?.conflictChoices).toEqual({});
  });

  it('hides ignored drift even when issue details are still returned', async () => {
    apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/skills/drift-check') {
        return {
          ok: true,
          json: async () => ({
            result: {
              newSkills: ['browser-preview'],
              conflicts: [
                {
                  skill: 'tdd',
                  kind: 'directory',
                  provider: 'claude',
                },
              ],
              stale: ['legacy-skill'],
              driftHash: 'ignored-hash',
              isIgnored: true,
            },
            projectRoot: '/tmp/project-a',
          }),
        };
      }
      throw new Error(`Unexpected apiFetch path: ${url}`);
    });

    act(() => {
      root.render(<SkillsDriftBanner projectPath="/tmp/project-a" />);
    });
    await flush();

    // When drift is ignored but no other issues, banner shows "完全同步"
    expect(container.textContent).toContain('✓ Skill 与源池完全同步');
  });
});
