/**
 * Host content-review returns are addressed to the cat: they carry a JSON
 * coordinate block and tool instructions. The human who triggered them should
 * see what happened in one line, with the machine text available on demand.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ConnectorBubble } from '../ConnectorBubble';

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: vi.fn(),
}));

const envelope = [
  '[Host 作品修改请求：原任务续办]',
  '人的明确请求已持久保存。继续下面的同一个 Task。',
  '{"requestId":"f309-modification-abc","taskId":"task-1","expectedTaskRevision":1}',
  '先用 cat_cafe_read_entrusted_work 和 cat_cafe_read_content_modification 读回请求。',
].join('\n');

describe('ConnectorBubble content-review return', () => {
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
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 200 }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    const message: ChatMessage = {
      id: 'm-review',
      type: 'connector',
      content: envelope,
      timestamp: Date.now(),
      source: { connector: 'content-review', label: '产物审阅', icon: 'cat-cafe' },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
  }

  it('renders a registered icon instead of the raw icon string', () => {
    render();
    expect(container.innerHTML).toContain('<svg');
    expect(container.textContent).not.toMatch(/^cat-cafe/);
  });

  it('shows a one-line summary and keeps the machine instructions collapsed', () => {
    render();
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(container.querySelector('summary')?.textContent).toContain('作品修改请求');
    // Coordinates and tool names live only inside the collapsed details.
    const outside = Array.from(container.querySelectorAll('*'))
      .filter((el) => !el.closest('details') && el.children.length === 0)
      .map((el) => el.textContent ?? '')
      .join(' ');
    expect(outside).not.toContain('requestId');
    expect(outside).not.toContain('cat_cafe_read_content_modification');
    expect(details?.textContent).toContain('cat_cafe_read_content_modification');
  });
});
