/**
 * F174 D2b-2 — CatAvatar callback-auth status dot rendering.
 *
 * Asserts the corner dot renders only when callbackAuthStatus is set, and
 * that the color matches烁烁's reviewed palette per status (Emerald/Amber/Red/Cafe-Muted).
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => ({
      id: 'opus',
      displayName: 'Opus',
      avatar: '/avatars/opus.png',
      color: { primary: '#9CA3AF', secondary: '#cccccc' },
    }),
    cats: [],
    refresh: () => {},
  }),
}));

import { CatAvatar } from '../CatAvatar';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('CatAvatar callback-auth status dot (F174 D2b-2)', () => {
  it('does NOT render dot when callbackAuthStatus is undefined', () => {
    const html = renderToStaticMarkup(<CatAvatar catId="opus" size={48} />);
    expect(html).not.toContain('data-testid="callback-auth-dot"');
  });

  it('renders green dot for healthy', () => {
    const html = renderToStaticMarkup(<CatAvatar catId="opus" size={48} callbackAuthStatus="healthy" />);
    expect(html).toContain('data-testid="callback-auth-dot"');
    expect(html).toContain('data-callback-auth-status="healthy"');
    expect(html.toUpperCase()).toContain('#22C55E'); // Emerald
  });

  it('renders amber dot for degraded', () => {
    const html = renderToStaticMarkup(<CatAvatar catId="opus" size={48} callbackAuthStatus="degraded" />);
    expect(html).toContain('data-callback-auth-status="degraded"');
    expect(html.toUpperCase()).toContain('#F59E0B'); // Amber
  });

  it('renders red dot for broken', () => {
    const html = renderToStaticMarkup(<CatAvatar catId="opus" size={48} callbackAuthStatus="broken" />);
    expect(html).toContain('data-callback-auth-status="broken"');
    expect(html.toUpperCase()).toContain('#EF4444'); // Red
  });

  it('renders muted dot for unknown', () => {
    const html = renderToStaticMarkup(<CatAvatar catId="opus" size={48} callbackAuthStatus="unknown" />);
    expect(html).toContain('data-callback-auth-status="unknown"');
    expect(html.toUpperCase()).toContain('#A89386'); // Cafe-Muted
  });

  it('uses provided callbackAuthLabel as title/aria-label', () => {
    const html = renderToStaticMarkup(
      <CatAvatar catId="opus" size={48} callbackAuthStatus="broken" callbackAuthLabel="opus: broken · 12 fails" />,
    );
    expect(html).toContain('opus: broken · 12 fails');
  });

  it('AC-D7: dot renders as <button> when onCallbackAuthClick is provided', () => {
    const html = renderToStaticMarkup(
      <CatAvatar catId="opus" size={48} callbackAuthStatus="broken" onCallbackAuthClick={() => {}} />,
    );
    // The dot wrapper now contains a <button> with the testid
    expect(html).toMatch(/<button[^>]*data-testid="callback-auth-dot"/);
  });

  it('AC-D7: dot renders as <span role=status> when no click handler (read-only badge)', () => {
    const html = renderToStaticMarkup(<CatAvatar catId="opus" size={48} callbackAuthStatus="broken" />);
    expect(html).toMatch(/<span[^>]*role="status"[^>]*data-testid="callback-auth-dot"/);
  });

  it('AC-D7: hover popover content is in the DOM tree even when initially hidden', () => {
    // SSR snapshot — popover is rendered conditionally on hover state, so it
    // should NOT appear on initial render. We just assert popover prop wiring
    // doesn't break SSR.
    const html = renderToStaticMarkup(
      <CatAvatar
        catId="opus"
        size={48}
        callbackAuthStatus="broken"
        callbackAuthPopover={<span>popover-fixture</span>}
        onCallbackAuthClick={() => {}}
      />,
    );
    expect(html).toMatch(/data-testid="callback-auth-dot"/);
    // popover hidden by default → not rendered yet
    expect(html).not.toContain('popover-fixture');
  });

  it('砚砚 P2 #1403: dot click does NOT bubble to parent onClick (no thread-switch surprise)', async () => {
    // Reproduces ThreadItem context: parent row has its own onClick (e.g.
    // onSelect(threadId)). Without stopPropagation, opening the D2b-3 panel
    // would also switch threads — a hidden context jump.
    const parentClicks: number[] = [];
    const dotClicks: number[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <div data-testid="parent-row" onClick={() => parentClicks.push(1)}>
          <CatAvatar catId="opus" size={48} callbackAuthStatus="broken" onCallbackAuthClick={() => dotClicks.push(1)} />
        </div>,
      );
    });
    const dot = container.querySelector('[data-testid="callback-auth-dot"]') as HTMLButtonElement;
    expect(dot).not.toBeNull();
    await act(async () => {
      dot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(dotClicks).toEqual([1]);
    expect(parentClicks).toEqual([]); // critical: parent must not fire
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
