import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollToMessage } from '@/utils/scrollToMessage';

// jsdom doesn't provide CSS.escape — polyfill for tests
beforeAll(() => {
  if (!globalThis.CSS) {
    (globalThis as Record<string, unknown>).CSS = {};
  }
  if (!CSS.escape) {
    CSS.escape = (value: string) => value.replace(/([^\w-])/g, '\\$1');
  }
});

describe('scrollToMessage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('scrolls to the element with matching data-message-id', () => {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-123');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    scrollToMessage('msg-123');

    expect(el.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });
  });

  it('adds highlight classes then removes after timeout', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-456');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    scrollToMessage('msg-456');

    expect(el.classList.contains('ring-2')).toBe(true);
    expect(el.classList.contains('ring-blue-400')).toBe(true);

    vi.advanceTimersByTime(1500);

    expect(el.classList.contains('ring-2')).toBe(false);
    expect(el.classList.contains('ring-blue-400')).toBe(false);

    vi.useRealTimers();
  });

  it('does nothing when element is not found', () => {
    // Should not throw
    scrollToMessage('nonexistent-id');
  });

  it('returns true when the target element is found (lets callers retry until DOM is ready)', () => {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-789');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    expect(scrollToMessage('msg-789')).toBe(true);
  });

  it('returns false when no matching element exists', () => {
    expect(scrollToMessage('missing-id')).toBe(false);
  });
});
