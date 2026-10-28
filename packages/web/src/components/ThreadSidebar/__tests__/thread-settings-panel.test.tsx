import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ThreadCatSettings', () => ({
  ThreadCatSettingsContent: () => React.createElement('div', { 'data-testid': 'cats-content' }, 'cats'),
}));
vi.mock('../ThreadEffortSettings', () => ({
  ThreadEffortSettingsContent: () => React.createElement('div', { 'data-testid': 'effort-content' }, 'effort'),
}));
vi.mock('../ThreadSpeedSettings', () => ({
  ThreadSpeedSettingsContent: () => React.createElement('div', { 'data-testid': 'speed-content' }, 'speed'),
}));
vi.mock('../ThreadLabelPicker', () => ({
  ThreadLabelSettingsContent: () => React.createElement('div', { 'data-testid': 'labels-content' }, 'labels'),
}));
vi.mock('../ThreadGoalSettings', () => ({
  ThreadGoalSettingsContent: () => React.createElement('div', { 'data-testid': 'goal-content' }, 'goal'),
}));
vi.mock('../ThreadNativeReviewSettings', () => ({
  ThreadNativeReviewSettingsContent: () => React.createElement('div', { 'data-testid': 'review-content' }, 'review'),
}));
vi.mock('../ThreadNativeStatusSettings', () => ({
  ThreadNativeStatusSettingsContent: () => React.createElement('div', { 'data-testid': 'status-content' }, 'status'),
}));

import { writeShellPresentation } from '../../shell/shell-presentation';
import { ThreadSettingsPanel } from '../ThreadSettingsPanel';

describe('ThreadSettingsPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('groups v2 settings in goal, execution and organization order, ending with the linked Feature', () => {
    writeShellPresentation('v2');
    render();
    const panel = document.querySelector('[data-testid="thread-settings-panel"]');
    const sections = Array.from(panel?.querySelectorAll('section > button') ?? []).map(
      (button) => button.querySelector('.font-semibold')?.textContent,
    );
    expect(sections).toEqual([
      '对话目标',
      '默认猫猫',
      '思考档位',
      '速度档位',
      'Codex 运行状态',
      '标签管理',
      '关联 Feature',
    ]);
    expect(
      Array.from(panel?.querySelectorAll('[data-settings-group]') ?? []).map((group) =>
        group.getAttribute('data-settings-group'),
      ),
    ).toEqual(['goal', 'execution', 'organization']);
  });

  it('keeps keyboard focus inside the same popover when entering and leaving background settings', () => {
    writeShellPresentation('v2');
    render();
    const panel = document.querySelector('[data-testid="thread-settings-panel"]');
    const entry = panel?.querySelector<HTMLButtonElement>('[data-testid="thread-background-entry"]');
    act(() => {
      entry?.focus();
      entry?.click();
    });
    const back = panel?.querySelector<HTMLButtonElement>('[aria-label="返回对话设置"]');
    expect(document.querySelector('[data-testid="thread-settings-panel"]')).toBe(panel);
    expect(document.activeElement).toBe(back);
    expect(panel?.querySelector('header button')).toBeNull();
    act(() => back?.click());
    expect(document.activeElement).toBe(panel?.querySelector('[data-testid="thread-background-entry"]'));
  });

  function render(onClose = vi.fn(), returnFocusRef?: React.RefObject<HTMLElement | null>, projectPath?: string) {
    act(() => {
      root.render(
        <ThreadSettingsPanel
          open
          threadId="thread-1"
          threadTitle="Thread 1"
          currentCats={[]}
          currentLabels={[]}
          onSavePreferredCats={vi.fn()}
          onSaveLabels={vi.fn()}
          onClose={onClose}
          returnFocusRef={returnFocusRef}
          projectPath={projectPath}
        />,
      );
    });
    return onClose;
  }

  function sectionButton(label: string) {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes(label),
    );
  }

  it('uses a bottom sheet only below md and aligns wider workspaces to the right rail', () => {
    render();

    const panel = document.body.querySelector<HTMLElement>('[data-testid="thread-settings-panel"]');
    expect(panel).not.toBeNull();
    expect(container.contains(panel)).toBe(false);
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.getAttribute('aria-modal')).toBe('false');
    expect(panel?.className).toContain('bottom-2');
    expect(panel?.className).toContain('md:inset-y-0');
    expect(panel?.className).toContain('md:left-auto');
    expect(panel?.className).toContain('md:right-0');
    expect(panel?.className).toContain('md:w-[400px]');
    expect(panel?.className).toContain('md:rounded-none');
    expect(panel?.className).toContain('md:border-y-0');
    expect(panel?.className).toContain('md:border-r-0');
    expect(panel?.className).not.toContain('lg:');
    expect(document.querySelector('[data-testid="thread-settings-backdrop"]')).toBeNull();
    expect(document.querySelector('[data-testid$="-content"]')).toBeNull();
  });

  it('keeps detail progressive by allowing only one expanded section', () => {
    render();

    act(() => sectionButton('默认猫猫')?.click());
    expect(document.querySelector('[data-testid="cats-content"]')).not.toBeNull();
    expect(sectionButton('默认猫猫')?.getAttribute('aria-expanded')).toBe('true');

    act(() => sectionButton('思考档位')?.click());
    expect(document.querySelector('[data-testid="cats-content"]')).toBeNull();
    expect(document.querySelector('[data-testid="effort-content"]')).not.toBeNull();
    expect(sectionButton('默认猫猫')?.getAttribute('aria-expanded')).toBe('false');
    expect(sectionButton('思考档位')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the supplied project path in full without adding it to unchanged callers', () => {
    const path = '/work/projects/一个不能靠悬停才能找到的完整项目路径';
    render(vi.fn(), undefined, path);
    expect(document.querySelector('[data-testid="thread-project-path"]')?.textContent).toContain(path);
    render();
    expect(document.querySelector('[data-testid="thread-project-path"]')).toBeNull();
  });

  it('keeps Goal and Codex runtime status in Thread settings while Review belongs to Workspace Changes', () => {
    render();
    expect(sectionButton('对话目标')).toBeDefined();
    expect(sectionButton('Codex 运行状态')).toBeDefined();
    expect(sectionButton('Codex 原生 Review')).toBeUndefined();
  });

  it('closes on outside pointer input without swallowing the underlying interaction', () => {
    const onClose = render();
    const outsideButton = document.createElement('button');
    const underlyingHandler = vi.fn();
    outsideButton.addEventListener('mousedown', underlyingHandler);
    document.body.appendChild(outsideButton);

    act(() => {
      outsideButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(underlyingHandler).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    outsideButton.remove();
  });

  it('closes on Escape and returns focus to the menu trigger', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const onClose = vi.fn();
    render(onClose, { current: trigger });

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
