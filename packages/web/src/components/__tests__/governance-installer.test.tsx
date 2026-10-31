import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const { GovernanceInstaller } = await import('@/components/GovernanceInstaller');

function response(report: Record<string, unknown>, ok = true, status = ok ? 200 : 409) {
  return { ok, status, json: async () => ({ ok, report, ...(ok ? {} : { error: 'preview changed' }) }) };
}

describe('GovernanceInstaller', () => {
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
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps every materialization group optional and says the project is already usable', () => {
    act(() => root.render(<GovernanceInstaller projectPath="/tmp/community-plugin" />));

    expect(container.textContent).toContain('猫猫已经可以在这个项目工作');
    expect(container.textContent).toContain('只有确认后才写入');
    for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      expect(checkbox.checked).toBe(false);
    }
  });

  it('previews the exact selection, renders actions, and confirms the same checksum', async () => {
    const preview = {
      previewChecksum: 'sha256:preview',
      actions: [{ file: 'AGENTS.md', action: 'created', reason: 'canonical guide', group: 'project-guide' }],
      selection: { projectGuide: { thinEntrypoints: [] } },
    };
    const installed = { ...preview, dryRun: false };
    mockApiFetch.mockResolvedValueOnce(response(preview)).mockResolvedValueOnce(response(installed));

    act(() => root.render(<GovernanceInstaller projectPath="/tmp/community-plugin" />));
    const guide = container.querySelector<HTMLInputElement>('[data-testid="governance-group-project-guide"]')!;
    await act(async () => guide.click());
    const previewButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '预览改动',
    )!;
    await act(async () => previewButton.click());

    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/governance/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/tmp/community-plugin',
        dryRun: true,
        selection: { projectGuide: { thinEntrypoints: [] } },
      }),
    });
    expect(container.textContent).toContain('AGENTS.md');
    expect(container.textContent).toContain('将创建');

    const confirmButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('确认写入'),
    )!;
    await act(async () => confirmButton.click());
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/governance/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/tmp/community-plugin',
        dryRun: false,
        selection: { projectGuide: { thinEntrypoints: [] } },
        expectedPreviewChecksum: 'sha256:preview',
      }),
    });
    expect(container.textContent).toContain('已按预览写入');
  });

  it('turns a stale confirmation into a fresh preview instead of claiming success', async () => {
    const preview = {
      previewChecksum: 'sha256:old',
      actions: [{ file: 'AGENTS.md', action: 'created', reason: 'guide' }],
      selection: { projectGuide: { thinEntrypoints: [] } },
    };
    const fresh = {
      ...preview,
      previewChecksum: 'sha256:fresh',
      actions: [{ file: 'AGENTS.md', action: 'skipped', reason: 'file already exists' }],
    };
    mockApiFetch.mockResolvedValueOnce(response(preview)).mockResolvedValueOnce(response(fresh, false));

    act(() => root.render(<GovernanceInstaller projectPath="/tmp/community-plugin" />));
    await act(async () =>
      container.querySelector<HTMLInputElement>('[data-testid="governance-group-project-guide"]')?.click(),
    );
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '预览改动')?.click(),
    );
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('确认写入'))?.click(),
    );

    expect(container.textContent).toContain('项目状态已变化，请重新确认');
    expect(container.textContent).toContain('已跳过');
    expect(container.textContent).not.toContain('已按预览写入');
  });

  it('previews cleanup before enabling confirmed deletion', async () => {
    const preview = {
      previewChecksum: 'sha256:cleanup',
      actions: [{ file: 'AGENTS.md', action: 'deleted', reason: 'generated content still matches' }],
      selection: {},
    };
    mockApiFetch
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(response({ ...preview, dryRun: false }));

    act(() => root.render(<GovernanceInstaller projectPath="/tmp/community-plugin" allowCleanup />));
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '预览撤销')?.click(),
    );
    expect(container.textContent).toContain('将删除');
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('确认撤销'))?.click(),
    );
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/governance/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/tmp/community-plugin',
        dryRun: false,
        expectedPreviewChecksum: 'sha256:cleanup',
      }),
    });
  });
});
