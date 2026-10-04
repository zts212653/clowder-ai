import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { ConnectorBubble } from '../ConnectorBubble';

const machineReport = [
  '[开发责任续办] registration=development-return-example; signal=terminal_report;',
  'task:work:example observedRevision=6; currentRevision=8',
  '执行现场已提交 completed；sourceMessage=message-example；evidence=https://example.test/pr/65。',
  '由原 owner 先重读同一 Task、当前授权和产物，再执行确切 owner action。',
].join('\n');

describe('ConnectorBubble development return', () => {
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(reason: string | undefined, content = machineReport) {
    const message: ChatMessage = {
      id: 'development-return-old-message',
      type: 'connector',
      content,
      timestamp: Date.now(),
      source: {
        connector: 'development-return',
        label: '开发结果回流',
        icon: 'cat-cafe',
        meta: reason ? { reason } : {},
      },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
  }

  it('renders a system SVG for an existing development-return message', () => {
    render('terminal_report');
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent).not.toMatch(/^cat-cafe/);
  });

  it('summarizes a child report without declaring the parent work complete, preserving the original detail', () => {
    render('terminal_report');
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain('执行现场已回报');
    expect(details?.querySelector('summary')?.textContent).toContain('原负责人将核验');
    expect(details?.querySelector('summary')?.textContent).not.toContain('工作已完成');
    const outside = Array.from(container.querySelectorAll('*'))
      .filter((element) => !element.closest('details') && element.children.length === 0)
      .map((element) => element.textContent ?? '')
      .join(' ');
    expect(outside).not.toContain('registration=');
    expect(details?.textContent).toContain('registration=development-return-example');
    expect(details?.textContent).toContain('https://example.test/pr/65');
  });

  it.each([
    ['deadline_review', '复核时间已到'],
    ['owner_changed', '开发回流已停止'],
    ['unrecognized', '开发回流有新消息'],
    [undefined, '开发回流有新消息'],
  ])('uses a truthful summary for reason %s', (reason, expected) => {
    render(reason);
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.querySelector('summary')?.textContent).toContain(expected);
    expect(container.querySelector('summary')?.textContent).not.toContain('工作已完成');
  });
});
