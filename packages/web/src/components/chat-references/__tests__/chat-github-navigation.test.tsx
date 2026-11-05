import type { ChatGitHubReference } from '@cat-cafe/shared';
import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChatGitHubReferenceView } from '../ChatGitHubReferenceView';

for (const layout of ['inline', 'card']) {
  for (const kind of ['registered-pr', 'external-pr', 'issue'] as const) {
    it(`opens the original GitHub page for ${layout} ${kind}, with changes as a separate action`, () => {
      vi.stubGlobal('React', React);
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const onOpen = vi.fn();
      const target: ChatGitHubReference = {
        kind: 'github',
        objectType: kind === 'issue' ? 'issue' : 'pull',
        repo: 'owner/repo',
        number: 1799,
        title: 'Recover Windows file action menus',
        state: 'open',
        url: `https://github.com/owner/repo/${kind === 'issue' ? 'issues' : 'pull'}/1799`,
        ...(kind === 'registered-pr' ? { worktreeId: 'project' } : {}),
      };
      try {
        act(() =>
          root.render(<ChatGitHubReferenceView layout={layout} anchor={createRef()} target={target} onOpen={onOpen} />),
        );
        const titleLink = [...container.querySelectorAll('a')].find((link) =>
          link.textContent?.includes('Recover Windows'),
        );
        expect(titleLink, 'The title remains a native GitHub link after metadata resolves').toBeDefined();
        expect(titleLink?.getAttribute('href')).toBe(target.url);
        expect(titleLink?.getAttribute('target')).toBe('_blank');
        expect(titleLink?.getAttribute('rel')).toContain('noopener');
        // Let the browser own navigation; suppress jsdom's unimplemented destination load only.
        titleLink?.addEventListener('click', (event) => event.preventDefault());
        act(() => titleLink?.click());
        expect(onOpen).not.toHaveBeenCalled();
        const changes = container.querySelector('button');
        if (kind === 'registered-pr') {
          expect(changes?.textContent).toMatch(/查看变更|View changes/);
          expect(titleLink?.contains(changes)).toBe(false);
          act(() => changes?.click());
          expect(onOpen).toHaveBeenCalledTimes(1);
        } else {
          expect(changes).toBeNull();
        }
      } finally {
        act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    });
  }
}
