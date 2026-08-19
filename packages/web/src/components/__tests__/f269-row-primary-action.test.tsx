import type { BacklogItem, MarketplaceSearchResult } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApiFetch, mockFetchCommitDetail, mockRefresh } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockFetchCommitDetail: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/components/content-overflow', () => ({
  ExpandableProse: ({ text }: { text: string }) => (
    <div data-testid={`prose-${text}`}>
      <span>{text}</span>
      <button type="button" onClick={(event) => event.stopPropagation()}>
        展开全文
      </button>
    </div>
  ),
}));

vi.mock('@/hooks/useCatNameResolver', () => ({
  useCatNameResolver: () => (catId: string) => catId,
}));

vi.mock('@/hooks/useGitPanel', () => ({
  useGitPanel: () => ({
    commits: [
      {
        hash: '0123456789abcdef',
        short: '0123456',
        author: 'Sol',
        date: new Date().toISOString(),
        subject: 'Restore the whole row hit target',
      },
    ],
    status: { branch: 'fix/test', staged: [], unstaged: [], untracked: [] },
    commitDetail: null,
    loading: false,
    error: null,
    fetchLog: vi.fn(),
    fetchStatus: vi.fn(),
    fetchCommitDetail: mockFetchCommitDetail,
    refresh: mockRefresh,
  }),
}));

vi.mock('@/components/workspace/HealthDashboard', () => ({
  HealthDashboard: () => null,
}));

import { type TemplateCard, TemplateStep } from '../first-run-quest/TemplateStep';
import { ArtifactCard } from '../marketplace/artifact-card';
import { MissionControlCard } from '../mission-control/MissionControlCard';
import { GitPanel } from '../workspace/GitPanel';

const TEMPLATE: TemplateCard = {
  id: 'maine',
  name: '缅因猫',
  nickname: '砚砚',
  avatar: '/avatars/maine.png',
  color: { primary: '#8b5e3c', secondary: '#f5e8d8' },
  roleDescription: '复杂系统攻坚',
  personality: '热情主动',
};

const MARKETPLACE_RESULT: MarketplaceSearchResult = {
  artifactId: 'artifact-1',
  artifactKind: 'skill',
  displayName: 'Row Action Skill',
  ecosystem: 'codex',
  sourceLocator: 'skills/row-action',
  trustLevel: 'verified',
  componentSummary: 'A summary that should keep the card primary action',
};

const BACKLOG_ITEM: BacklogItem = {
  id: 'f269',
  userId: 'user-1',
  title: 'Restore row actions',
  summary: 'Mission summary body',
  priority: 'p2',
  tags: ['frontend'],
  status: 'open',
  createdBy: 'user',
  createdAt: 1,
  updatedAt: 1,
  audit: [],
};

describe('F269 row primary action recovery', () => {
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
    mockApiFetch.mockReset();
    mockFetchCommitDetail.mockReset();
    mockRefresh.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('selects a template from its description body and shows a compact selected check', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ templates: [TEMPLATE] }),
    });
    const onSelect = vi.fn();

    await act(async () => {
      root.render(<TemplateStep onSelect={onSelect} />);
      await Promise.resolve();
    });

    const description = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === TEMPLATE.roleDescription,
    );
    expect(description).toBeTruthy();
    act(() => description?.click());

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(TEMPLATE);
    const selectButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(TEMPLATE.name),
    );
    expect(selectButton?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-selection-indicator]')).toBeTruthy();
    expect(container.textContent).not.toContain('选择此模板');
    expect(container.textContent).not.toContain('已选择');

    onSelect.mockClear();
    const expand = Array.from(container.querySelectorAll('button')).find((button) =>
      button.closest(`[data-testid="prose-${TEMPLATE.roleDescription}"]`),
    );
    act(() => expand?.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens a marketplace artifact from summary body without double-firing its native button', () => {
    const onSelect = vi.fn();
    act(() => root.render(<ArtifactCard result={MARKETPLACE_RESULT} onSelect={onSelect} />));

    const summary = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === MARKETPLACE_RESULT.componentSummary,
    );
    act(() => summary?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);

    onSelect.mockClear();
    const nativeButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(MARKETPLACE_RESULT.displayName),
    );
    act(() => nativeButton?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('selects a mission from its summary or tag without double-firing its native button', () => {
    const onSelect = vi.fn();
    act(() => root.render(<MissionControlCard item={BACKLOG_ITEM} selected={false} onSelect={onSelect} />));

    const tag = Array.from(container.querySelectorAll('span')).find((element) => element.textContent === '#frontend');
    act(() => tag?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(BACKLOG_ITEM.id);

    onSelect.mockClear();
    const nativeButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(BACKLOG_ITEM.title),
    );
    act(() => nativeButton?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('toggles a commit from its subject or author without double-firing its native button', () => {
    act(() => root.render(<GitPanel />));

    const author = Array.from(container.querySelectorAll('div')).find((element) => element.textContent === 'Sol');
    act(() => author?.click());
    expect(mockFetchCommitDetail).toHaveBeenCalledTimes(1);
    expect(mockFetchCommitDetail).toHaveBeenCalledWith('0123456789abcdef');

    mockFetchCommitDetail.mockClear();
    const nativeButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('0123456'),
    );
    act(() => nativeButton?.click());
    expect(mockFetchCommitDetail).not.toHaveBeenCalled();
    expect(nativeButton?.textContent).toContain('查看详情');
  });
});
