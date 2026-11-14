// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { beginChatScroll, registerChatScrollOwner } from '../chat-scroll-owner';

describe('the viewport keeps its existing user-scroll owner', () => {
  it('cannot borrow another viewport or unregister a replacement owner through an old cleanup', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');
    const original = vi.fn(() => ({ scrollTo: vi.fn(() => true), end: vi.fn() }));
    const replacement = vi.fn(() => ({ scrollTo: vi.fn(() => true), end: vi.fn() }));
    expect(beginChatScroll(first)).toBeNull();
    const releaseOriginal = registerChatScrollOwner(first, original);
    expect(beginChatScroll(second)).toBeNull();
    expect(original).not.toHaveBeenCalled();
    expect(beginChatScroll(first)).not.toBeNull();
    const releaseReplacement = registerChatScrollOwner(first, replacement);
    releaseOriginal();
    expect(beginChatScroll(first)).not.toBeNull();
    expect(replacement).toHaveBeenCalledOnce();
    releaseReplacement();
    expect(beginChatScroll(first)).toBeNull();
  });
});
