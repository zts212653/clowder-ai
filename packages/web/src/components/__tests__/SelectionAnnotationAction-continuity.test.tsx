import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSelectionAnnotationAction } from '../LiveSelectionAnnotationAction';
import { MessageAnnotationActions } from '../MessageAnnotationActions';
import {
  type MessageActionOwnership,
  MessageActionOwnershipProvider,
  useMessageActionOwnership,
} from '../message-v2/message-action-ownership';

const selection = { text: 'The selected source passage', position: { top: 80, left: 80 } };

describe('annotation draft during incoming-message layout changes', () => {
  let root: Root;
  let container: HTMLDivElement;
  let owner: MessageActionOwnership;
  const save = vi.fn();

  function Harness({ selectionPresent = true, incomingCount = 0 }) {
    owner = useMessageActionOwnership('source-message');
    return (
      <MessageActionOwnershipProvider value={owner}>
        <div>{incomingCount} incoming messages</div>
        <LiveSelectionAnnotationAction
          action={selectionPresent ? selection : null}
          resetKey="source-message"
          positionMode="fixed"
          actionTestId="selection-trigger"
          onSave={save}
        />
      </MessageActionOwnershipProvider>
    );
  }
  function editor() {
    return document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
  }
  async function openDraft() {
    await act(async () => {
      owner.settle(true, true);
      document.querySelector<HTMLButtonElement>('[data-testid="selection-trigger"]')!.click();
    });
    await act(async () => {
      const textarea = editor()!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Half-written comment',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return editor()!;
  }

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    save.mockReset();
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('retains the same focused draft and selected passage while the source scrolls out and messages arrive', async () => {
    const textarea = await openDraft();
    for (let incomingCount = 1; incomingCount <= 3; incomingCount++) {
      await act(async () => {
        owner.pending(() => false);
        root.render(<Harness selectionPresent={false} incomingCount={incomingCount} />);
      });
      expect(editor()).toBe(textarea);
      expect(document.activeElement).toBe(textarea);
      expect(textarea.closest('section')!.hasAttribute('inert')).toBe(false);
      await act(async () => owner.settle(false, false));
      expect(editor()).toBe(textarea);
      expect(textarea.value).toBe('Half-written comment');
      expect(document.querySelector('blockquote')!.textContent).toBe(selection.text);
      await act(async () => owner.settle(true, true));
    }
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="context-annotation-save"]')!.click(),
    );
    expect(save).toHaveBeenCalledWith(selection, 'Half-written comment');
    expect(editor()).toBeNull();
  });

  it('keeps an unavailable source trigger gated before the editor is opened', async () => {
    const trigger = document.querySelector('[data-testid="selection-trigger"]')!;
    expect(trigger.hasAttribute('inert')).toBe(true);
    await act(async () => owner.settle(true, true));
    expect(trigger.hasAttribute('inert')).toBe(false);
    await act(async () => owner.pending(() => false));
    expect(trigger.hasAttribute('inert')).toBe(true);
  });

  it.each(['outside', 'Escape'] as const)('closes only on intentional %s dismissal', async (dismissal) => {
    const textarea = await openDraft();
    await act(async () => {
      textarea.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(editor()).toBe(textarea);
    await act(async () => {
      if (dismissal === 'outside') container.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      else textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(editor()).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('retains the draft when saving is refused', async () => {
    save.mockReturnValue(false);
    const textarea = await openDraft();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="context-annotation-save"]')!.click(),
    );
    expect(editor()).toBe(textarea);
    expect(textarea.value).toBe('Half-written comment');
  });

  it('keeps the opened numbered draft when another trigger retires before marker geometry updates', async () => {
    function Markers({ visible = true }) {
      owner = useMessageActionOwnership('source-message');
      return (
        <MessageActionOwnershipProvider value={owner}>
          <MessageAnnotationActions
            markers={
              visible
                ? [1, 2].map((number) => ({
                    number,
                    position: selection.position,
                    attachment: {
                      v: 1,
                      id: `marker-${number}`,
                      kind: 'quote',
                      text: selection.text,
                      comment: 'old comment',
                      source: { kind: 'message', threadId: 'thread-1', messageId: 'source-message' },
                    },
                  }))
                : []
            }
            onSave={save}
            onDelete={() => {}}
          />
        </MessageActionOwnershipProvider>
      );
    }
    await act(async () => root.render(<Markers />));
    await act(async () => {
      owner.settle(true, true);
      document.querySelector<HTMLButtonElement>('[data-testid="context-annotation-marker-marker-2"]')!.click();
    });
    const textarea = editor()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Still writing the second comment',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Owner retirement and Range projection are independent browser observers.
    await act(async () => owner.settle(false, false));
    await act(async () => root.render(<Markers visible={false} />));
    expect(editor()).toBe(textarea);
    expect(textarea.value).toBe('Still writing the second comment');
    expect(document.activeElement).toBe(textarea);
  });
});
