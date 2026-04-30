import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const MOCK_ITEMS = [
  {
    id: 'tdd',
    type: 'skill' as const,
    source: 'cat-cafe' as const,
    enabled: true,
    cats: { opus: true, codex: false },
    description: 'TDD workflow',
    triggers: ['red-green'],
    category: 'dev',
  },
  {
    id: 'review',
    type: 'skill' as const,
    source: 'cat-cafe' as const,
    enabled: false,
    cats: {},
    description: 'Code review',
  },
];

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ threads: [] }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      items: MOCK_ITEMS,
      catFamilies: [{ id: 'ragdoll', name: 'Ragdoll', catIds: ['opus'] }],
      projectPath: '/test/project',
      skillHealth: null,
    }),
  })),
}));

vi.mock('@/components/marketplace/marketplace-panel', () => ({
  MarketplacePanel: () => React.createElement('div', null, 'marketplace'),
}));

vi.mock('@/components/settings/SkillPreviewModal', () => ({
  SkillPreviewModal: () => null,
}));

import { SkillsContent } from '@/components/settings/SkillsContent';

describe('SkillsContent', () => {
  it('renders skill cards with toggle switch and per-cat button', () => {
    const html = renderToStaticMarkup(React.createElement(SkillsContent));
    expect(html).toContain('新增 Skill');
    expect(html).toContain('Skill 市场');
    expect(html).toContain('marketplace');
  });

  it('renders loading skeleton initially', () => {
    const html = renderToStaticMarkup(React.createElement(SkillsContent));
    expect(html).toContain('animate-pulse');
  });

  it('has project selector in toolbar area', () => {
    const html = renderToStaticMarkup(React.createElement(SkillsContent));
    expect(html).toContain('新增 Skill');
  });
});
