import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HubMemberOverviewCard } from '@/components/HubMemberOverviewCard';
import type { CatData } from '@/hooks/useCatData';

function makeCat(overrides: Partial<CatData> & { id: string; clientId: string }): CatData {
  return {
    displayName: overrides.id,
    color: { primary: '#000', secondary: '#111' },
    mentionPatterns: [],
    carrier: 'cli',
    defaultModel: 'test-model',
    avatar: '',
    roleDescription: '',
    personality: '',
    roster: { family: 'test', roles: [], lead: false, available: true, evaluation: '' },
    ...overrides,
  };
}

const PROVIDER_TYPES = ['anthropic', 'openai', 'antigravity', 'google', 'opencode'] as const;

describe('#723 list-level member deletion coverage', () => {
  it.each(PROVIDER_TYPES)('renders delete button at list level for %s provider', (clientId) => {
    const cat = makeCat({ id: `cat-${clientId}`, clientId });
    const html = renderToStaticMarkup(
      React.createElement(HubMemberOverviewCard, {
        cat,
        onDelete: () => {},
        onEdit: () => {},
      }),
    );
    expect(html).toContain(`aria-label="删除成员：${cat.displayName}"`);
    expect(html).toContain(`title="删除成员：${cat.displayName}"`);
  });

  it('does not render delete button when onDelete is omitted', () => {
    const cat = makeCat({ id: 'cat-no-delete', clientId: 'anthropic' });
    const html = renderToStaticMarkup(
      React.createElement(HubMemberOverviewCard, {
        cat,
        onEdit: () => {},
      }),
    );
    expect(html).not.toContain('删除成员');
  });

  it('delete button fires onDelete with the correct cat data', () => {
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    const cat = makeCat({ id: 'cat-callback', clientId: 'openai' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<HubMemberOverviewCard cat={cat} onDelete={onDelete} onEdit={onEdit} />));
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="删除成员：${cat.displayName}"]`);
      expect(button).not.toBeNull();
      act(() => button?.click());
      expect(onDelete).toHaveBeenCalledExactlyOnceWith(cat);
      expect(onEdit).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('disabled cats also get delete button at list level', () => {
    const cat = makeCat({
      id: 'cat-disabled',
      clientId: 'antigravity',
      roster: { family: 'test', roles: [], lead: false, available: false, evaluation: '' },
    });
    const html = renderToStaticMarkup(
      React.createElement(HubMemberOverviewCard, {
        cat,
        onDelete: () => {},
        onEdit: () => {},
      }),
    );
    expect(html).toContain(`aria-label="删除成员：${cat.displayName}"`);
  });
});
