import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resolveLayoutThreadId } from '../layout';
import Home from '../page';
import ThreadPage from '../thread/[threadId]/page';

describe('chat route markers', () => {
  it('renders a stable marker for the default thread route', () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('data-thread-route="default"');
  });

  it('renders the active thread id into the page tree', () => {
    const html = renderToStaticMarkup(<ThreadPage params={{ threadId: 'thread-123' }} />);
    expect(html).toContain('data-thread-route="thread-123"');
  });

  it('uses pathname for first render, then trusts the browser route store after hydration', () => {
    expect(resolveLayoutThreadId('thread-refresh', null)).toBe('thread-refresh');
    expect(resolveLayoutThreadId('default', null, 'thread-refresh')).toBe('thread-refresh');
    expect(resolveLayoutThreadId('thread-stale', 'default')).toBe('default');
    expect(resolveLayoutThreadId('thread-stale', 'thread-current')).toBe('thread-current');
  });
});
