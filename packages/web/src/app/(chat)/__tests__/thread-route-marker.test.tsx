import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ClassicHome from '../../classic/page';
import { resolveLayoutThreadId } from '../../classic/route-state';
import ClassicThreadPage from '../../classic/thread/[threadId]/page';
import Home from '../page';

describe('console and classic route markers', () => {
  it('renders a stable marker for the console default route', () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('data-thread-route="default"');
  });

  it('renders a stable marker for the classic default route', () => {
    const html = renderToStaticMarkup(<ClassicHome />);
    expect(html).toContain('data-thread-route="default"');
  });

  it('renders the active thread id into the classic page tree', () => {
    const html = renderToStaticMarkup(<ClassicThreadPage params={{ threadId: 'thread-123' }} />);
    expect(html).toContain('data-thread-route="thread-123"');
  });

  it('uses pathname for first render, then trusts the browser route store after hydration', () => {
    expect(resolveLayoutThreadId('thread-refresh', null)).toBe('thread-refresh');
    expect(resolveLayoutThreadId('default', null, 'thread-refresh')).toBe('thread-refresh');
    expect(resolveLayoutThreadId('thread-stale', 'default')).toBe('default');
    expect(resolveLayoutThreadId('thread-stale', 'thread-current')).toBe('thread-current');
  });
});
