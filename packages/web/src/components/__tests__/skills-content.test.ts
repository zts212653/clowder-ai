import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandleDisableSkill = vi.fn();

const MOCK_ITEMS_WITH_EXTERNAL = [
  {
    id: 'tdd',
    type: 'skill' as const,
    source: 'cat-cafe' as const,
    enabled: true,
    cats: { opus: true },
    description: 'TDD workflow',
    triggers: ['red-green'],
    category: 'dev',
  },
  {
    id: 'ext-plugin',
    type: 'skill' as const,
    source: 'external' as const,
    enabled: true,
    cats: {},
    description: 'External plugin',
  },
];

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ threads: [] }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      items: MOCK_ITEMS_WITH_EXTERNAL,
      catFamilies: [],
      projectPath: '/test/project',
      skillHealth: null,
    }),
  })),
}));

vi.mock('@/components/settings/SkillPreviewModal', () => ({
  SkillPreviewModal: () => null,
}));

vi.mock('@/components/settings/useCapabilityState', () => ({
  useCapabilityState: () => ({
    items: MOCK_ITEMS_WITH_EXTERNAL,
    loading: false,
    toggling: null,
    catFamilies: [],
    resolvedProjectPath: '/test/project',
    knownProjects: [],
    projectPath: '/test/project',
    switchProject: vi.fn(),
    handleToggle: vi.fn(),
    handleDisableSkill: mockHandleDisableSkill,
  }),
}));

import { SkillsContent } from '@/components/settings/SkillsContent';

describe('SkillsContent', () => {
  it('renders header (SSR)', () => {
    const html = renderToStaticMarkup(React.createElement(SkillsContent));
    expect(html).toContain('Skill 管理');
  });

  describe('with loaded items', () => {
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
      mockHandleDisableSkill.mockReset();
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    it('shows uninstall button only for external skills', async () => {
      await act(async () => {
        root.render(React.createElement(SkillsContent));
      });

      const uninstallButtons = container.querySelectorAll('button[aria-label="卸载 Skill"]');
      expect(uninstallButtons).toHaveLength(1);

      const card = uninstallButtons[0].closest('[class*="settings-resource-card"]');
      expect(card?.textContent).toContain('ext-plugin');
    });

    it('calls handleDisableSkill when uninstall button is clicked', async () => {
      await act(async () => {
        root.render(React.createElement(SkillsContent));
      });

      const uninstallBtn = container.querySelector('button[aria-label="卸载 Skill"]') as HTMLButtonElement;
      await act(async () => {
        uninstallBtn.click();
      });

      expect(mockHandleDisableSkill).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ext-plugin', source: 'external' }),
      );
    });

    it('does not show uninstall button for cat-cafe managed skills', async () => {
      await act(async () => {
        root.render(React.createElement(SkillsContent));
      });

      const cards = container.querySelectorAll('[class*="settings-resource-card"]');
      const managedCard = Array.from(cards).find((c) => c.textContent?.includes('tdd'));
      expect(managedCard?.querySelector('button[aria-label="卸载 Skill"]')).toBeNull();
    });
  });
});
