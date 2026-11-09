import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { data, homeContentFixture, imageArtifact } from './home-content-fixture';

const second = { ...imageArtifact, name: '第二张', sourceMessageId: 'second-source', url: '/uploads/second.png' };
function arrow(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing gallery control: ${label}`);
  return button;
}
function thumbnails() {
  return document.querySelectorAll('[data-testid="artwork-gallery-thumbnails"] button');
}
async function key(value: string) {
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })));
}
function prependNewWorks() {
  data.artifacts = [
    ...Array.from({ length: 3 }, (_, index) => ({
      ...imageArtifact,
      name: `New publication ${index}`,
      sourceMessageId: `new-${index}`,
      url: `/uploads/new-${index}.png`,
    })),
    ...data.artifacts,
  ];
}

describe('Home uses the common artwork gallery', () => {
  const scene = homeContentFixture();
  beforeEach(() => {
    // JSDOM has no layout; visibility itself is checked with production CSS in Chromium.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps the opened group and focus when newer publications change the Home summary', async () => {
    data.artifacts = [imageArtifact, second];
    await scene.render();
    await scene.open();
    const next = arrow('下一件作品');
    next.focus();
    prependNewWorks();
    await scene.render();
    expect(thumbnails()).toHaveLength(2);
    expect(next.disabled).toBe(false);
    expect(document.activeElement).toBe(next);
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(imageArtifact.url);
    await act(async () => next.click());
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(second.url);
    expect(arrow('下一件作品').disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement?.closest('[data-testid="artwork-gallery-thumbnails"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('aria-current')).toBe('true');
  });

  it('bounds both directions while keyboard focus stays on an enabled gallery item', async () => {
    data.artifacts = [imageArtifact, second];
    await scene.render();
    await scene.open();
    const selected = thumbnails()[0] as HTMLButtonElement;
    selected.focus();
    await key('ArrowLeft');
    expect(arrow('上一件作品').disabled).toBe(true);
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(imageArtifact.url);
    await key('ArrowRight');
    expect(arrow('下一件作品').disabled).toBe(true);
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(second.url);
    const admissionCount = data.fetch.mock.calls.length;
    await key('ArrowRight');
    expect(data.fetch.mock.calls).toHaveLength(admissionCount);
    expect(document.activeElement).toBe(selected);
    expect(selected.disabled).toBe(false);
    await key('ArrowLeft');
    expect(arrow('上一件作品').disabled).toBe(true);
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(imageArtifact.url);
    expect(document.activeElement).toBe(selected);
  });

  it('does not steal another owner’s focus or arrow keys after a catalogue refresh', async () => {
    const ownerControl = document.createElement('button');
    document.body.append(ownerControl);
    try {
      data.artifacts = [imageArtifact, second];
      await scene.render();
      await scene.open();
      arrow('下一件作品').focus();
      ownerControl.focus();
      prependNewWorks();
      await scene.render();
      expect(arrow('下一件作品').disabled).toBe(false);
      expect(document.activeElement).toBe(ownerControl);
      const admissionCount = data.fetch.mock.calls.length;
      await key('ArrowRight');
      expect(data.fetch.mock.calls).toHaveLength(admissionCount);
      expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(imageArtifact.url);
      expect(document.activeElement).toBe(ownerControl);
    } finally {
      ownerControl.remove();
    }
  });
});
