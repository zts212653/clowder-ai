import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
});
