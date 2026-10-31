import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { ConnectorBubble } from '../ConnectorBubble';

describe('ConnectorBubble deployment wait avatar', () => {
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

  function render(connector: string, icon: string) {
    const message: ChatMessage = {
      id: 'persisted-deployment-return',
      type: 'connector',
      from: { kind: 'external', connectorId: connector, sender: { id: 'deployment', name: 'Deployment Wait' } },
      content: 'Deployment ready — return to the original task for acceptance.',
      timestamp: 1791160380000,
      source: { connector, label: 'Deployment Wait', icon },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    return container.querySelector('.rounded-full');
  }

  it.each(['refresh-cw', 'legacy-icon'])('renders a registry SVG for persisted source.icon=%s', (icon) => {
    const avatar = render('deployment-wait', icon);
    const svg = avatar?.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(avatar?.textContent).toBe('');
    expect(container.textContent).toContain('Deployment Wait');
    expect(container.textContent).toContain('return to the original task for acceptance.');
  });

  it('uses the declared person identity for an unregistered external connector', () => {
    const avatar = render('unregistered-source', 'X');
    expect(avatar?.textContent).toBe('D');
  });
});
