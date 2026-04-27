/**
 * F174 D2b-2 (rev3) — callback-auth UNREAD badge merged into HubButton.
 *
 * rev3 fixes 铲屎官 alpha 验收 #3 ("红点点开也点不掉 + 强制跳 observability + 视觉撑爆"):
 *   1. Badge uses `unviewedFailures24h` (clears on view) — not `totalFailures24h`
 *   2. Click ALWAYS opens default Hub — no deep-link (rev2 stole user intent)
 *   3. Badge maxWidth 22px hard cap — even "99+" can't visually dominate hub icon
 *
 * Behavior matrix:
 *   isAvailable=false                    → no badge (zero pollution)
 *   24h unviewedFailures = 0             → no badge (all viewed / no failures)
 *   24h unviewedFailures 1-5             → amber badge with count
 *   24h unviewedFailures >= 6            → red badge with count
 *   total > 99                           → "99+" cap (within maxWidth 22px)
 *
 * Click semantics (rev3 simplified):
 *   ALWAYS → openHub() (no args). Badge clears via HubCallbackAuthPanel onMount.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let mockAvailable = false;
let mockAggregate = {
  byReason: {},
  byTool: {},
  totalFailures24h: 0,
  unviewedFailures24h: 0,
  topReasons: [],
  topTools: [],
};
let mockOpenHub: (tab?: string, subTab?: string) => void = () => {};

vi.mock('@/stores/callbackAuthStore', () => ({
  useCallbackAuthAvailable: () => mockAvailable,
  useCallbackAuthAggregate: () => mockAggregate,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: { openHub: (tab?: string, subTab?: string) => void }) => unknown) =>
    selector({ openHub: mockOpenHub }),
}));

import { HubButton } from '../HubButton';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('HubButton — F174 D2b-2 (rev3) callback-auth unread badge', () => {
  it('renders without badge when snapshot is unavailable (non-owner)', () => {
    mockAvailable = false;
    mockAggregate = {
      byReason: {},
      byTool: {},
      totalFailures24h: 0,
      unviewedFailures24h: 0,
      topReasons: [],
      topTools: [],
    };
    const html = renderToStaticMarkup(<HubButton />);
    expect(html).toContain('data-testid="hub-button"');
    expect(html).not.toContain('data-testid="hub-button-callback-auth-badge"');
    expect(html).not.toContain('data-callback-auth-unviewed');
  });

  it('renders without badge when available + 0 unviewed (all viewed already)', () => {
    mockAvailable = true;
    mockAggregate = {
      byReason: {},
      byTool: {},
      totalFailures24h: 5, // there ARE failures but already viewed
      unviewedFailures24h: 0,
      topReasons: [],
      topTools: [],
    };
    const html = renderToStaticMarkup(<HubButton />);
    expect(html).toContain('data-testid="hub-button"');
    expect(html).not.toContain('data-testid="hub-button-callback-auth-badge"');
    expect(html).not.toContain('data-callback-auth-unviewed');
  });

  it('renders amber badge when 1-5 unviewed (degraded)', () => {
    mockAvailable = true;
    mockAggregate = {
      byReason: {},
      byTool: {},
      totalFailures24h: 3,
      unviewedFailures24h: 3,
      topReasons: [],
      topTools: [],
    };
    const html = renderToStaticMarkup(<HubButton />);
    expect(html).toContain('data-testid="hub-button-callback-auth-badge"');
    expect(html).toContain('data-callback-auth-unviewed="3"');
    expect(html.toUpperCase()).toContain('#F59E0B'); // amber
    expect(html).toContain('>3<');
    // rev3: tooltip uses "未查看" + tells user how to clear (open Hub subtab)
    expect(html).toContain('3 次未查看失败');
    expect(html).toContain('打开 Hub 查看可观测性子 tab 即可清除');
  });

  it('renders red badge when >= 6 unviewed (broken)', () => {
    mockAvailable = true;
    mockAggregate = {
      byReason: {},
      byTool: {},
      totalFailures24h: 12,
      unviewedFailures24h: 12,
      topReasons: [],
      topTools: [],
    };
    const html = renderToStaticMarkup(<HubButton />);
    expect(html).toContain('data-callback-auth-unviewed="12"');
    expect(html.toUpperCase()).toContain('#EF4444'); // red
    expect(html).toContain('>12<');
  });

  it('caps badge text at "99+" for very high counts AND enforces maxWidth 22px', () => {
    mockAvailable = true;
    mockAggregate = {
      byReason: {},
      byTool: {},
      totalFailures24h: 250,
      unviewedFailures24h: 250,
      topReasons: [],
      topTools: [],
    };
    const html = renderToStaticMarkup(<HubButton />);
    expect(html).toContain('99+');
    expect(html).toContain('data-callback-auth-unviewed="250"'); // raw count preserved in attr
    // rev3 P0 visual fix: maxWidth 22px guard (alpha #3: "16" badge ~70% of hub icon)
    expect(html).toContain('max-width:22px');
    expect(html).toContain('overflow:hidden');
  });

  it('uses no emoji in icon (铲屎官 instruction: SVG only)', () => {
    mockAvailable = true;
    mockAggregate = {
      byReason: {},
      byTool: {},
      totalFailures24h: 0,
      unviewedFailures24h: 0,
      topReasons: [],
      topTools: [],
    };
    const html = renderToStaticMarkup(<HubButton />);
    expect(html).toContain('<svg'); // SVG element
    expect(html).not.toContain('🔌'); // no plug emoji
    expect(html).not.toContain('⚙️'); // no gear emoji
  });

  it('rev3: click without badge calls openHub() with no args (default Hub)', async () => {
    mockAvailable = true;
    mockAggregate = {
      byReason: {},
      byTool: {},
      totalFailures24h: 0,
      unviewedFailures24h: 0,
      topReasons: [],
      topTools: [],
    };
    const calls: Array<[string?, string?]> = [];
    mockOpenHub = (tab, subTab) => {
      calls.push([tab, subTab]);
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<HubButton />);
    });

    const button = container.querySelector('[data-testid="hub-button"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(calls).toEqual([[undefined, undefined]]);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    mockOpenHub = () => {};
  });

  it('rev3: click WITH badge ALSO calls openHub() (no args) — NO deep-link (撤回 alpha #3 否决)', async () => {
    // Critical regression: alpha #3 ("万一我想看的是原本的成员呢") — click hub
    // must respect user's default-Hub intent regardless of badge presence.
    // Badge only carries unread information; subtab navigation clears it.
    mockAvailable = true;
    mockAggregate = {
      byReason: {},
      byTool: {},
      totalFailures24h: 7,
      unviewedFailures24h: 7,
      topReasons: [],
      topTools: [],
    };
    const calls: Array<[string?, string?]> = [];
    mockOpenHub = (tab, subTab) => {
      calls.push([tab, subTab]);
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<HubButton />);
    });

    const button = container.querySelector('[data-testid="hub-button"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    // rev3: no deep-link even with badge — calls openHub() no args
    expect(calls).toEqual([[undefined, undefined]]);
    // Explicit assertion that args are NOT 'observability', 'callback-auth' (rev2 form)
    expect(calls[0]).not.toEqual(['observability', 'callback-auth']);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    mockOpenHub = () => {};
  });
});
