import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ADD_TO_CHAT_LABEL } from '@/components/SelectionAnnotationAction';
import { AddToChatButton } from '../WorkspaceMediaChatControls';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('offers the same action under the same name as the text selection card: one concept, one name', async () => {
  const chat = { offered: true, add: vi.fn(), notice: null, clearNotice: vi.fn(), marks: undefined };
  await act(async () => root.render(<AddToChatButton chat={chat} />));
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="workspace-content-review-media-add-to-chat"]',
  );
  expect(button?.textContent?.trim()).toBe(ADD_TO_CHAT_LABEL);
  expect(button?.title).toBe(ADD_TO_CHAT_LABEL);
  expect(button?.textContent).not.toMatch(/Add to chat/i);
});

it('is not shown when there is no circled place to add', async () => {
  const chat = { offered: false, add: vi.fn(), notice: null, clearNotice: vi.fn(), marks: undefined };
  await act(async () => root.render(<AddToChatButton chat={chat} />));
  expect(container.querySelector('button')).toBeNull();
});
