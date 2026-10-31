import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderChatContainer, resetChatContainerMocks } from './chat-container-test-helpers';

const connection = vi.hoisted(() => ({
  api: 'online',
  socket: 'online',
  upstream: 'online',
  browserOnline: true,
  isReadonly: false,
  forwardingBlocked: true,
  updateRequired: false,
  checkedAt: 0,
}));
vi.mock('@/hooks/useConnectionStatus', () => ({ useConnectionStatus: () => connection }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetChatContainerMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  connection.isReadonly = false;
  connection.updateRequired = false;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('the real ChatContainer only asks for a reload when the revision is mismatched, not merely unverified', async () => {
  await act(async () => root.render(renderChatContainer('thread-a')));
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  connection.updateRequired = true;
  connection.isReadonly = true;
  await act(async () => root.render(renderChatContainer('thread-a')));
  const dialog = host.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain('页面已经更新');
  expect(dialog?.contains(document.activeElement)).toBe(true);
});
