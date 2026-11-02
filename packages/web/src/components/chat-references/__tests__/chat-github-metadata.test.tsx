import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChatGitHubReferenceView } from '../ChatGitHubReferenceView';
import styles from '../chat-reference.module.css';

it('keeps each separator with its following metadata item and retains readable text boundaries', () => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <ChatGitHubReferenceView
          layout="card"
          anchor={createRef()}
          onOpen={() => {}}
          target={{
            kind: 'github',
            repo: 'owner/repo',
            number: 5961,
            objectType: 'pull',
            url: 'https://github.com/owner/repo/pull/5961',
            title: 'A real change',
            state: 'merged',
            additions: 238,
            deletions: 208,
            changedFiles: 11,
            author: 'author',
            updatedAt: '2026-10-23T09:18:00Z',
          }}
        />,
      ),
    );
    for (const selector of [styles.prRepository, styles.prStatus]) {
      const group = container.querySelector(`.${selector}`)!;
      const parts = [...group.querySelectorAll('span[title]')];
      expect(parts.length).toBeGreaterThan(1);
      const labels = parts.map((part) => part.getAttribute('title'));
      expect(parts.map((part) => part.textContent)).toEqual(
        labels.map((label, index) => `${index === 0 ? '' : ' · '}${label}`),
      );
      expect(group.textContent).toContain(labels.join(' · '));
      expect(parts.every((part) => !part.closest('[aria-hidden="true"]'))).toBe(true);
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
