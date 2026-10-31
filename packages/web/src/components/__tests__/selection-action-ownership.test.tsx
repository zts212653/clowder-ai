import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type MessageActionOwnership,
  MessageActionOwnershipProvider,
  useMessageActionOwnership,
} from '../message-v2/message-action-ownership';
import { SelectionAnnotationAction } from '../SelectionAnnotationAction';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

describe('body selection uses readable message ownership rather than the author anchor', () => {
  let h: ReplyLayersHarness;
  let owner: MessageActionOwnership;
  const close = vi.fn();
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    h = new ReplyLayersHarness();
    close.mockClear();
    function OwnedSelection() {
      owner = useMessageActionOwnership('body-owner');
      return (
        <MessageActionOwnershipProvider value={owner}>
          <SelectionAnnotationAction
            selectedText="The visible answer remains readable."
            position={{ left: 150, top: 200 }}
            positionMode="fixed"
            actionTestId="owned-selection"
            onSave={vi.fn()}
            onClose={close}
          />
        </MessageActionOwnershipProvider>
      );
    }
    act(() => h.root.render(<OwnedSelection />));
    act(() => owner.settle(true, true));
  });
  afterEach(() => h.dispose());

  function openEditor() {
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="owned-selection"]');
    if (!trigger) throw new Error('Missing real selection trigger');
    act(() => trigger.click());
    const editor = document.querySelector<HTMLElement>('[data-testid="context-annotation-editor"]');
    if (!editor) throw new Error('Missing real selection editor');
    return editor;
  }

  it('keeps a readable selection clickable while only toolbar geometry is pending', () => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="owned-selection"]');
    if (!trigger) throw new Error('Missing real selection trigger');
    const toolbar = document.createElement('button');
    document.body.append(toolbar);
    const unregister = owner.register(toolbar, 'anchor');
    try {
      act(() => {
        trigger.focus();
        owner.pending(() => true);
      });
      expect(trigger.hasAttribute('data-message-action-unavailable')).toBe(false);
      expect(trigger.hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(trigger);
      expect(toolbar.hasAttribute('inert')).toBe(true);
      expect(openEditor().contains(document.activeElement)).toBe(true);
    } finally {
      unregister();
      toolbar.remove();
    }
  });

  it('revokes a selection immediately when the source becomes unreadable during measurement', () => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="owned-selection"]');
    if (!trigger) throw new Error('Missing real selection trigger');
    act(() => owner.pending(() => true));
    expect(trigger.hasAttribute('inert')).toBe(false);
    act(() => owner.pending(() => false));
    expect(trigger.hasAttribute('inert')).toBe(true);
    expect(trigger.getAttribute('aria-hidden')).toBe('true');
  });

  it('preserves the opened draft and focus through pending paint and author-anchor loss', () => {
    const editor = openEditor();
    expect(editor.contains(document.activeElement)).toBe(true);
    act(() => owner.pending(() => false));
    expect(editor.hasAttribute('inert')).toBe(false);
    expect(editor.getAttribute('aria-hidden')).not.toBe('true');
    expect(editor.contains(document.activeElement)).toBe(true);
    act(() => owner.settle(true, false));
    expect(editor.isConnected).toBe(true);
    expect(editor.hasAttribute('data-message-action-unavailable')).toBe(false);
    expect(close).not.toHaveBeenCalled();
    const comment = editor.querySelector<HTMLTextAreaElement>('textarea');
    act(() => comment?.focus());
    expect(editor.contains(document.activeElement)).toBe(true);
  });

  it('keeps the chosen text draft on source loss, then gates a new selection until the source recovers', () => {
    const editor = openEditor();
    act(() => owner.settle(false, false));
    expect(editor.isConnected).toBe(true);
    expect(editor.contains(document.activeElement)).toBe(true);
    expect(close).not.toHaveBeenCalled();
    // An explicit outside gesture closes the owned draft; source loss itself cannot discard it.
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(editor.isConnected).toBe(false);
    expect(close).toHaveBeenCalled();
    const trigger = document.querySelector<HTMLElement>('[data-testid="owned-selection"]');
    expect(trigger?.hasAttribute('inert')).toBe(true);
    act(() => owner.settle(true, false));
    const fresh = openEditor();
    expect(fresh.hasAttribute('inert')).toBe(false);
    expect(fresh.contains(document.activeElement)).toBe(true);
  });
});
