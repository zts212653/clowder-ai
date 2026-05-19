// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BucketBadge, SourceBadge } from '../mission-control/TriageBadge';

describe('TriageBadge', () => {
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  describe('BucketBadge', () => {
    it('renders build_now with green styling', () => {
      act(() => {
        root.render(React.createElement(BucketBadge, { bucket: 'build_now' }));
      });
      const badge = container.querySelector('[data-testid="bucket-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe('Build Now');
      expect(badge?.className).toContain('green');
    });

    it('renders clarify_first with yellow styling', () => {
      act(() => {
        root.render(React.createElement(BucketBadge, { bucket: 'clarify_first' }));
      });
      const badge = container.querySelector('[data-testid="bucket-badge"]');
      expect(badge?.textContent).toBe('Clarify First');
      expect(badge?.className).toContain('yellow');
    });

    it('renders validate_first with orange styling', () => {
      act(() => {
        root.render(React.createElement(BucketBadge, { bucket: 'validate_first' }));
      });
      const badge = container.querySelector('[data-testid="bucket-badge"]');
      expect(badge?.textContent).toBe('Validate First');
      expect(badge?.className).toContain('orange');
    });

    it('renders challenge with red styling', () => {
      act(() => {
        root.render(React.createElement(BucketBadge, { bucket: 'challenge' }));
      });
      const badge = container.querySelector('[data-testid="bucket-badge"]');
      expect(badge?.textContent).toBe('Challenge');
      expect(badge?.className).toContain('red');
    });

    it('renders later with neutral cafe styling', () => {
      act(() => {
        root.render(React.createElement(BucketBadge, { bucket: 'later' }));
      });
      const badge = container.querySelector('[data-testid="bucket-badge"]');
      expect(badge?.textContent).toBe('Later');
      expect(badge?.className).toContain('cafe');
    });
  });

  describe('SourceBadge', () => {
    it('renders Q tag with blue styling', () => {
      act(() => {
        root.render(React.createElement(SourceBadge, { tag: 'Q' }));
      });
      const badge = container.querySelector('[data-testid="source-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toContain('Q');
      expect(badge?.className).toContain('blue');
    });

    it('renders A tag with red styling', () => {
      act(() => {
        root.render(React.createElement(SourceBadge, { tag: 'A' }));
      });
      const badge = container.querySelector('[data-testid="source-badge"]');
      expect(badge?.textContent).toContain('A');
      expect(badge?.className).toContain('red');
    });

    it('renders all 5 source tags', () => {
      const tags = ['Q', 'O', 'D', 'R', 'A'] as const;
      for (const tag of tags) {
        act(() => {
          root.render(React.createElement(SourceBadge, { tag }));
        });
        const badge = container.querySelector('[data-testid="source-badge"]');
        expect(badge).toBeTruthy();
        expect(badge?.textContent).toContain(tag);
      }
    });
  });
});
