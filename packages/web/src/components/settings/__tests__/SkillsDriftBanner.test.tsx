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
      issues: [
        {
          skill: 'tdd',
          type: 'conflict',
          mountPoint: 'claude',
          message: 'claude 存在同名目录占用（立即同步会覆盖和清理已有内容，请先确认是否需要进行备份）',
        },
      ],
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

  // P2-2: 'clears destructive conflict choices when switching projects' test removed —
  // G5/G7 removed skip/override radio UI, so the test's DOM expectations are stale.

  it('renders backend issue message verbatim with the conflict backup warning', async () => {
    act(() => {
      root.render(<SkillsDriftBanner projectPath="/tmp/project-a" />);
    });
    await flush();

    expect(container.textContent).toContain('检测到 1 项 Skill 异常');
    const detail = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('查看详情'));
    act(() => {
      detail?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('tdd');
    expect(dialog?.textContent).toContain('存在同名目录占用');
    expect(dialog?.textContent).toContain('立即同步会覆盖和清理已有内容，请先确认是否需要进行备份');
  });

  it('closes the detail dialog when the backdrop is clicked', async () => {
    act(() => {
      root.render(<SkillsDriftBanner projectPath="/tmp/project-a" />);
    });
    await flush();
    const detail = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('查看详情'));
    act(() => {
      detail?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const overlay = document.querySelector('[role="dialog"]');
    expect(overlay).toBeTruthy();
    act(() => {
      overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
