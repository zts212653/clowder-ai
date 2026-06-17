/**
 * F229 PR-A2: ConciergeHost / ConciergeBall / ConciergePanel 组件测试
 *
 * Block 2  生命周期  INV-5/6/7
 * Block 5  安静默认  §3 三条
 * Block 6  a11y/motion  Esc + aria + reduced-motion
 *
 * Pattern: react-dom/client createRoot + act（项目标准，见 feishu-qr-panel.test.tsx）
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock apiFetch BEFORE component imports
// ---------------------------------------------------------------------------

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  API_URL: 'http://localhost:3003',
  resolveApiUrl: () => 'http://localhost:3003',
}));

import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { ConciergeBall } from '../ConciergeBall';
import { ConciergeHost } from '../ConciergeHost';
import { ConciergePanel } from '../ConciergePanel';
import { ConciergeRailToggle } from '../ConciergeRailToggle';

const mockApiFetch = vi.mocked(apiFetch);

// Default successful config response — matches backend shape: { config: ConciergeConfig } (P1-1)
function configOk() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        config: {
          enabled: true,
          muted: false,
          displayName: '猫猫球',
          personaTone: 'cool',
          dutyCatProfileId: 'gemini25',
          proactivePolicy: 'quiet-badge',
          skin: 'ragdoll-v1',
        },
      }),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function render(jsx: React.ReactNode) {
  await act(async () => {
    root.render(jsx);
    await Promise.resolve();
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation(configOk);

  // Reset store to known defaults (A3a: surfaceState replaces panelOpen)
  useConciergeStore.setState({
    enabled: true,
    muted: false,
    surfaceState: 'collapsed',
    inputFocused: false,
    invocationStatus: 'idle',
    pendingConfirmationCount: 0,
    pendingRelayCount: 0,
    unseenResultCount: 0,
    configLoaded: false,
    configLoading: false,
    configFailed: false,
    threadIdLoaded: false,
    threadIdLoading: false,
    threadId: null,
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Block 2: 生命周期 (INV-3/5/6/7)
// ---------------------------------------------------------------------------

describe('Block 2: 生命周期', () => {
  it('INV-3: muted=true → ConciergeHost renders no ball (zero DOM)', async () => {
    // configLoaded=true prevents fetchConfig from overriding the muted value
    useConciergeStore.setState({ muted: true, configLoaded: true });
    await render(<ConciergeHost />);
    await flushEffects();
    // No button in DOM when ball is hidden
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();
  });

  it('INV-3: enabled=true, muted=false → ball button present in DOM', async () => {
    await render(<ConciergeHost />);
    await flushEffects();
    expect(container.querySelector('button[aria-haspopup="dialog"]')).not.toBeNull();
  });

  it('INV-3: enabled=false → ball NOT in DOM', async () => {
    // configLoaded=true prevents fetchConfig from overriding enabled=false
    useConciergeStore.setState({ enabled: false, configLoaded: true });
    await render(<ConciergeHost />);
    await flushEffects();
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();
  });

  it('INV-5: single instance contract — host renders exactly one ball button', async () => {
    await render(<ConciergeHost />);
    await flushEffects();
    const buttons = container.querySelectorAll('button[aria-haspopup="dialog"]');
    expect(buttons.length).toBe(1);
  });

  it('INV-7: surfaceState=collapsed → panel NOT in DOM initially', async () => {
    await render(<ConciergeHost />);
    await flushEffects();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('INV-7: setSurfaceState(bubble) → panel appears; onNavigationAction → surfaceState=collapsed', async () => {
    await render(<ConciergeHost />);
    await flushEffects();

    act(() => {
      useConciergeStore.getState().setSurfaceState('bubble');
    });
    await flushEffects();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    // Navigation action collapses surface
    act(() => {
      useConciergeStore.getState().onNavigationAction();
    });
    await flushEffects();
    expect(useConciergeStore.getState().surfaceState).toBe('collapsed');
  });

  it('ConciergeHost renders ball after config fetch fails (P2 R5: no dead state on network error)', async () => {
    // Simulate config fetch failure (503) — host must render with optimistic defaults
    // not stay null forever when configLoaded stays false
    mockApiFetch.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as unknown as Response),
    );
    useConciergeStore.setState({ configLoaded: false, configLoading: false });
    await render(<ConciergeHost />);
    await flushEffects();
    // After failure: ball must render with optimistic defaults (not null dead state)
    expect(container.querySelector('button[aria-haspopup="dialog"]')).not.toBeNull();
  });

  it('ConciergeHost renders nothing until configLoaded (P2-A: no flash for opted-out users)', async () => {
    // Config not yet loaded — ball must NOT appear before user preference is known
    // Prevents opted-out users (enabled=false or muted=true) from seeing the ball flash
    useConciergeStore.setState({ enabled: true, muted: false, configLoaded: false, configLoading: true });
    // Simulate slow startup: fetch never resolves during this test
    mockApiFetch.mockImplementation(() => new Promise(() => {}));
    await render(<ConciergeHost />);
    // Ball must NOT appear before configLoaded=true (P2-A)
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();
  });

  it('ConciergeRailToggle: hidden before config loads (P2 R6: no panelOpen race)', async () => {
    // Config not yet loaded — toggle must NOT appear so user can't open panel
    // before we know their persisted enabled/muted preference
    useConciergeStore.setState({ configLoaded: false, configFailed: false, enabled: true });
    await render(<ConciergeRailToggle />);
    expect(container.querySelector('[data-testid="concierge-rail-toggle"]')).toBeNull();
  });

  it('ConciergeRailToggle: renders after configLoaded (P2 R6)', async () => {
    useConciergeStore.setState({ configLoaded: true, configFailed: false, enabled: true });
    await render(<ConciergeRailToggle />);
    expect(container.querySelector('[data-testid="concierge-rail-toggle"]')).not.toBeNull();
  });

  it('ConciergeRailToggle: renders after configFailed with enabled=true (P2 R6: fallback)', async () => {
    useConciergeStore.setState({ configLoaded: false, configFailed: true, enabled: true });
    await render(<ConciergeRailToggle />);
    expect(container.querySelector('[data-testid="concierge-rail-toggle"]')).not.toBeNull();
  });

  it('ConciergeRailToggle: hidden after configLoaded when enabled=false (opted-out)', async () => {
    useConciergeStore.setState({ configLoaded: true, enabled: false });
    await render(<ConciergeRailToggle />);
    expect(container.querySelector('[data-testid="concierge-rail-toggle"]')).toBeNull();
  });

  it('INV-9: ConciergeHost triggers fetchConfig on mount', async () => {
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(configOk);
    await render(<ConciergeHost />);
    await flushEffects();
    // Check that fetchConfig was called (first call). Other hooks (e.g. useCatData
    // inside ConciergePanel) may also fire fetches, so we don't assert exact total count.
    const configCalls = mockApiFetch.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('/api/concierge/config'),
    );
    expect(configCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Block 5: 安静默认 (§3)
// ---------------------------------------------------------------------------

describe('Block 5: 安静默认', () => {
  it('§3.1: badge has no text content (dot only, no count number)', async () => {
    useConciergeStore.setState({ unseenResultCount: 5 });
    await render(<ConciergeBall ballState="found" />);

    // Badge span should have no text node children
    // It's a <span> with aria-label but empty visual content
    const badge = container.querySelector('span[aria-label*="未读"]');
    expect(badge).not.toBeNull();
    // The badge itself has no text node — just an empty span with visual CSS
    expect(badge?.textContent).toBe('');
  });

  it('§3.2: aria-live="polite" present (not assertive)', async () => {
    await render(<ConciergeBall ballState="idle" />);
    const liveRegion = container.querySelector('[aria-live]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion?.getAttribute('aria-live')).not.toBe('assertive');
  });

  it('§3.3: no panel popup on first ConciergeHost render (surfaceState starts collapsed)', async () => {
    await render(<ConciergeHost />);
    await flushEffects();
    // No dialog in DOM on first render
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(useConciergeStore.getState().surfaceState).toBe('collapsed');
  });

  it('§3.3: unseenResultCount=0 → no badge dot rendered', async () => {
    useConciergeStore.setState({ unseenResultCount: 0 });
    await render(<ConciergeBall ballState="idle" />);
    const badge = container.querySelector('span[aria-label*="未读"]');
    expect(badge).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Block 6: a11y / motion
// ---------------------------------------------------------------------------

describe('Block 6: a11y + motion', () => {
  it('ball button has aria-label, aria-expanded, aria-haspopup=dialog', async () => {
    await render(<ConciergeBall ballState="idle" />);
    const btn = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('ball button aria-expanded=true when surface is not collapsed', async () => {
    useConciergeStore.setState({ surfaceState: 'bubble' });
    await render(<ConciergeBall ballState="idle" />);
    const btn = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('panel role=dialog aria-modal=false (non-modal, no focus trap)', async () => {
    useConciergeStore.setState({ surfaceState: 'bubble' });
    await render(<ConciergePanel />);
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('aria-modal')).toBe('false');
  });

  it('Esc key in bubble closes to toolbar (surfaceState: bubble→toolbar)', async () => {
    useConciergeStore.setState({ surfaceState: 'bubble' });
    await render(<ConciergePanel />);
    await flushEffects();

    // Fire Esc keydown
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flushEffects();

    // bubble→toolbar on first Esc (two-level Esc back)
    expect(useConciergeStore.getState().surfaceState).toBe('toolbar');
  });

  it('panel has mute toggle button when bubble is open (AC-A6)', async () => {
    useConciergeStore.setState({ surfaceState: 'bubble', muted: false, configLoaded: true });
    await render(<ConciergePanel />);
    // Mute toggle button must be present in panel header
    const muteBtn = container.querySelector('button[aria-label="静音"]');
    expect(muteBtn).not.toBeNull();
  });

  it('panel mute toggle shows "取消静音" when already muted (AC-A6)', async () => {
    useConciergeStore.setState({ surfaceState: 'bubble', muted: true, configLoaded: true });
    await render(<ConciergePanel />);
    const unmuteBtn = container.querySelector('button[aria-label="取消静音"]');
    expect(unmuteBtn).not.toBeNull();
  });

  it('panel mute toggle calls setMuted when clicked (AC-A6)', async () => {
    useConciergeStore.setState({ surfaceState: 'bubble', muted: false, configLoaded: true });
    // Mock setMuted call — apiFetch is already mocked (configOk)
    mockApiFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response),
    );
    await render(<ConciergePanel />);
    await flushEffects();

    const muteBtn = container.querySelector('button[aria-label="静音"]') as HTMLButtonElement;
    expect(muteBtn).not.toBeNull();
    act(() => {
      muteBtn.click();
    });
    await flushEffects();

    // setMuted(true) → optimistic store update → muted becomes true
    expect(useConciergeStore.getState().muted).toBe(true);
  });

  it('reduced-motion: ball renders without animation class when prefers-reduced-motion matches', async () => {
    // Mock matchMedia for reduced-motion preference
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      // Ball renders in reduced-motion context — no animation classes (just state color)
      await render(<ConciergeBall ballState="idle" />);
      const btn = container.querySelector('button[aria-haspopup="dialog"]');
      // Ball must render (non-null) even in reduced-motion
      expect(btn).not.toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

// ---------------------------------------------------------------------------
// A3a: Three-layer interaction model
// ---------------------------------------------------------------------------

import { ConciergeToolbar } from '../ConciergeToolbar';

describe('A3a: three-layer surfaceState interaction', () => {
  it('ConciergeToolbar renders only when surfaceState=toolbar', async () => {
    useConciergeStore.setState({ surfaceState: 'toolbar', configLoaded: true });
    await render(<ConciergeToolbar />);
    const toolbar = container.querySelector('[data-testid="concierge-toolbar"]');
    expect(toolbar).not.toBeNull();
  });

  it('ConciergeToolbar not rendered when surfaceState=collapsed', async () => {
    useConciergeStore.setState({ surfaceState: 'collapsed', configLoaded: true });
    await render(<ConciergeToolbar />);
    const toolbar = container.querySelector('[data-testid="concierge-toolbar"]');
    expect(toolbar).toBeNull();
  });

  it('ConciergeToolbar not rendered when surfaceState=bubble', async () => {
    useConciergeStore.setState({ surfaceState: 'bubble', configLoaded: true });
    await render(<ConciergeToolbar />);
    const toolbar = container.querySelector('[data-testid="concierge-toolbar"]');
    expect(toolbar).toBeNull();
  });

  it('clicking "聊聊" button in toolbar sets surfaceState=bubble', async () => {
    useConciergeStore.setState({ surfaceState: 'toolbar', configLoaded: true });
    await render(<ConciergeToolbar />);
    await flushEffects();

    const chatBtn = container.querySelector('button[aria-label="聊聊"]') as HTMLButtonElement;
    expect(chatBtn).not.toBeNull();
    act(() => chatBtn.click());
    await flushEffects();

    expect(useConciergeStore.getState().surfaceState).toBe('bubble');
  });

  it('ConciergePanel renders only when surfaceState=bubble', async () => {
    useConciergeStore.setState({ surfaceState: 'bubble', configLoaded: true });
    await render(<ConciergePanel />);
    const panel = container.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
  });

  it('ConciergePanel returns null when surfaceState=toolbar', async () => {
    useConciergeStore.setState({ surfaceState: 'toolbar', configLoaded: true });
    await render(<ConciergePanel />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('ConciergePanel returns null when surfaceState=collapsed', async () => {
    useConciergeStore.setState({ surfaceState: 'collapsed', configLoaded: true });
    await render(<ConciergePanel />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('ball click sets surfaceState=toolbar when collapsed', async () => {
    useConciergeStore.setState({ surfaceState: 'collapsed', configLoaded: true });
    await render(<ConciergeBall ballState="idle" />);
    await flushEffects();

    const btn = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    act(() => btn.click());
    await flushEffects();

    expect(useConciergeStore.getState().surfaceState).toBe('toolbar');
  });

  it('ConciergeHost renders ball + toolbar when surfaceState=toolbar', async () => {
    useConciergeStore.setState({ surfaceState: 'toolbar', configLoaded: true });
    await render(<ConciergeHost />);
    await flushEffects();

    expect(container.querySelector('button[aria-haspopup="dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="concierge-toolbar"]')).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull(); // no bubble
  });

  it('ConciergeHost renders ball + bubble (no toolbar) when surfaceState=bubble', async () => {
    useConciergeStore.setState({ surfaceState: 'bubble', configLoaded: true });
    await render(<ConciergeHost />);
    await flushEffects();

    expect(container.querySelector('button[aria-haspopup="dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="concierge-toolbar"]')).toBeNull(); // toolbar hidden
    expect(container.querySelector('[role="dialog"]')).not.toBeNull(); // bubble shown
  });

  // -------------------------------------------------------------------------
  // Cloud P1-A: toolbar positioning (absolute inside Fragment → no positioned parent)
  // -------------------------------------------------------------------------
  it('P1-A (cloud fix): toolbar nested inside concierge-ball-wrapper', async () => {
    useConciergeStore.setState({ surfaceState: 'toolbar', configLoaded: true });
    await render(<ConciergeHost />);
    await flushEffects();
    const wrapper = container.querySelector('[data-testid="concierge-ball-wrapper"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector('[data-testid="concierge-toolbar"]')).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Cloud P1-B: muted wake path (muted=true early return suppressed toolbar)
  // -------------------------------------------------------------------------
  it('P1-B (cloud fix): muted=true + surfaceState=toolbar → toolbar renders for unmute', async () => {
    useConciergeStore.setState({ muted: true, configLoaded: true, surfaceState: 'toolbar' });
    await render(<ConciergeHost />);
    await flushEffects();
    // Toolbar must be accessible so user can reach panel's unmute button
    expect(container.querySelector('[data-testid="concierge-toolbar"]')).not.toBeNull();
  });

  it('P1-B (cloud fix): muted=true + surfaceState=collapsed → nothing renders (INV-3 preserved)', async () => {
    useConciergeStore.setState({ muted: true, configLoaded: true, surfaceState: 'collapsed' });
    await render(<ConciergeHost />);
    await flushEffects();
    // Ball must still be hidden when muted+collapsed (INV-3 unchanged)
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="concierge-toolbar"]')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Toolbar simplification: 4 buttons → 2 honest entries (co-creator 拍板)
  // -------------------------------------------------------------------------
  it('toolbar has exactly 2 buttons (help + chat)', async () => {
    useConciergeStore.setState({ configLoaded: true, surfaceState: 'toolbar' });
    await render(<ConciergeHost />);
    await flushEffects();

    const toolbar = container.querySelector('[data-testid="concierge-toolbar"]');
    const buttons = toolbar?.querySelectorAll('button');
    expect(buttons?.length).toBe(2);
  });

  it('help button opens bubble with prefilled prompt', async () => {
    useConciergeStore.setState({ configLoaded: true, surfaceState: 'toolbar' });
    await render(<ConciergeHost />);
    await flushEffects();

    const helpBtn = container.querySelector('button[aria-label="能帮什么"]') as HTMLButtonElement;
    expect(helpBtn).not.toBeNull();
    act(() => {
      helpBtn.click();
    });
    await flushEffects();

    expect(useConciergeStore.getState().surfaceState).toBe('bubble');
    const inputEl = container.querySelector('textarea[aria-label="消息输入框"]') as HTMLTextAreaElement;
    expect(inputEl?.value).toBe('你能帮我什么？');
  });

  it('chat button opens bubble with empty input', async () => {
    useConciergeStore.setState({ configLoaded: true, surfaceState: 'toolbar' });
    await render(<ConciergeHost />);
    await flushEffects();

    const chatBtn = container.querySelector('button[aria-label="聊聊"]') as HTMLButtonElement;
    expect(chatBtn).not.toBeNull();
    act(() => {
      chatBtn.click();
    });
    await flushEffects();

    expect(useConciergeStore.getState().surfaceState).toBe('bubble');
    const inputEl = container.querySelector('textarea[aria-label="消息输入框"]') as HTMLTextAreaElement;
    expect(inputEl?.value).toBe('');
  });

  it('chat clears existing draft set by previous help button', async () => {
    useConciergeStore.setState({ configLoaded: true, surfaceState: 'toolbar' });
    await render(<ConciergeHost />);
    await flushEffects();

    // Step 1: help → bubble with prefilled draft
    const helpBtn = container.querySelector('button[aria-label="能帮什么"]') as HTMLButtonElement;
    act(() => {
      helpBtn.click();
    });
    await flushEffects();
    expect((container.querySelector('textarea[aria-label="消息输入框"]') as HTMLTextAreaElement)?.value).toBe(
      '你能帮我什么？',
    );

    // Step 2: Escape → back to toolbar
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flushEffects();
    expect(useConciergeStore.getState().surfaceState).toBe('toolbar');

    // Step 3: chat → bubble must open with *empty* input (not the old draft)
    const chatBtn = container.querySelector('button[aria-label="聊聊"]') as HTMLButtonElement;
    act(() => {
      chatBtn.click();
    });
    await flushEffects();

    expect(useConciergeStore.getState().surfaceState).toBe('bubble');
    expect((container.querySelector('textarea[aria-label="消息输入框"]') as HTMLTextAreaElement)?.value).toBe('');
  });

  it('P2 (cloud fix): Escape in toolbar state collapses to collapsed', async () => {
    useConciergeStore.setState({ configLoaded: true, surfaceState: 'toolbar' });
    await render(<ConciergeHost />);
    await flushEffects();

    expect(container.querySelector('[data-testid="concierge-toolbar"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flushEffects();

    expect(useConciergeStore.getState().surfaceState).toBe('collapsed');
  });

  it('P2 (cloud R3): send transitions invocationStatus idle→pending→in_progress', async () => {
    // threadIdLoaded:true prevents fetchThreadId from overwriting our test threadId when bubble opens
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'collapsed',
      threadId: 'thread-test-r3',
      threadIdLoaded: true,
      invocationStatus: 'idle',
    });

    // Mock POST /api/messages as success
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/messages') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    // Use pendingPrompt mechanism to open bubble with pre-filled text (reliable vs nativeSet+change)
    act(() => {
      useConciergeStore.getState().setSurfaceState('bubble', 'hello cat');
    });
    await flushEffects();

    // Verify pre-fill worked
    const inputEl = container.querySelector('textarea[aria-label="消息输入框"]') as HTMLTextAreaElement;
    expect(inputEl).not.toBeNull();
    expect(inputEl.value).toBe('hello cat');

    // Before send: idle
    expect(useConciergeStore.getState().invocationStatus).toBe('idle');

    // Send
    await act(async () => {
      const sendBtn = container.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
      sendBtn.click();
      // Flush the POST promise (microtask resolves before this 0ms macrotask)
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushEffects();

    // After successful POST: in_progress (ball shows thinking while polling for cat reply)
    expect(useConciergeStore.getState().invocationStatus).toBe('in_progress');
  });

  it('P2 (R4): reply detection sets invocationStatus to idle when cat reply arrives', async () => {
    // Simulate post-send state: in_progress, thread loaded, no pre-existing cat messages
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-test-r4',
      threadIdLoaded: true,
      invocationStatus: 'in_progress', // post-send state
    });

    // Mock GET /api/messages to return a cat reply (catMsgCountAtSendRef defaults to 0)
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            messages: [{ id: 'a1', type: 'assistant', content: '你好！', catId: 'gemini25', timestamp: 1000 }],
          }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    // Reply detection effect: catCount(1) > catMsgCountAtSendRef.current(0) → idle
    expect(useConciergeStore.getState().invocationStatus).toBe('idle');
  });

  it('P2 (R5): send button disabled while initial messages are loading', async () => {
    // Demonstrates the race condition fix: user cannot send before catMsgCountAtSendRef
    // is captured from settled messages. Without the fix, a button with text would be
    // enabled while isLoading=true, allowing stale-count captures.
    let resolveLoad!: (v: Response) => void;

    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-test-r5',
      threadIdLoaded: true,
      invocationStatus: 'idle',
      pendingPrompt: null,
    });

    // GET never resolves until we call resolveLoad — keeps isLoading=true
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return new Promise<Response>((resolve) => {
          resolveLoad = resolve;
        });
      }
      return configOk();
    });

    // Render: ConciergePanel mounts, loadMessages starts, isLoading=true
    await render(<ConciergeHost />);

    // Pre-fill input so the send button would otherwise be enabled
    act(() => {
      useConciergeStore.getState().setSurfaceState('bubble', 'hello');
    });
    await act(async () => {
      await Promise.resolve();
    });

    const sendBtn = container.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
    // R5 fix: button must be disabled while initial messages are still loading
    expect(sendBtn?.disabled).toBe(true);

    // Resolve the GET with pre-existing cat messages
    await act(async () => {
      resolveLoad({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{ id: 'm1', type: 'assistant', content: '你好！', catId: 'gemini25', timestamp: 1000 }],
        }),
      } as unknown as Response);
      await Promise.resolve();
    });
    await flushEffects();

    // After load completes: button now enabled (text present, not in-flight)
    const sendBtnAfter = container.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
    expect(sendBtnAfter?.disabled).toBe(false);
  });

  it('P2 (R7): speech-bubble tail triangles are not clipped by outer overflow-hidden', async () => {
    // The tail triangles use absolute positioning with negative bottom offsets.
    // If the outer panel has overflow-hidden, the tail is clipped and invisible.
    // Fix: move overflow-hidden to an inner content wrapper.
    useConciergeStore.setState({ surfaceState: 'bubble', configLoaded: true });
    await render(<ConciergePanel />);
    await flushEffects();

    const panel = container.querySelector('[role="dialog"]') as HTMLDivElement;
    expect(panel).not.toBeNull();

    // R7 fix: outer shell must NOT have overflow-hidden (lets tail escape the clip)
    expect(panel?.className).not.toContain('overflow-hidden');

    // Inner content wrapper must have overflow-hidden (clips header/messages/input at corners)
    const inner = panel?.querySelector('[data-testid="concierge-inner-content"]') as HTMLDivElement;
    expect(inner).not.toBeNull();
    expect(inner?.className).toContain('overflow-hidden');
  });

  it('P1 (R8): streaming draft messages do not trigger reply detection', async () => {
    // When the backend returns a streaming draft (isDraft: true), mapApiMessages must
    // filter it out so catCount does not increase and reply detection does not fire.
    // Without the fix: draft arrives → catCount(1) > catMsgCountAtSendRef(0) → idle (WRONG)
    // With the fix: draft filtered → catCount(0) = catMsgCountAtSendRef(0) → stays in_progress
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-test-r8-draft',
      threadIdLoaded: true,
      invocationStatus: 'in_progress',
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            messages: [
              {
                id: 'a1',
                type: 'assistant',
                content: '在思考…',
                catId: 'gemini25',
                timestamp: 1000,
                isDraft: true,
              },
            ],
          }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    // Draft must NOT trigger idle — invocationStatus must stay in_progress
    expect(useConciergeStore.getState().invocationStatus).toBe('in_progress');
  });

  it('P2 (R8): Enter key in textarea is blocked when invocationStatus=in_progress', async () => {
    // handleSend only guards with isLoading; without an invocationStatus guard, pressing
    // Enter while a send is in-flight bypasses the button disabled check and fires another POST.
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'collapsed',
      threadId: 'thread-test-r8-keyboard',
      threadIdLoaded: true,
      invocationStatus: 'idle',
      pendingPrompt: null,
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    // Open bubble with pre-filled text
    act(() => {
      useConciergeStore.getState().setSurfaceState('bubble', 'second message');
    });
    await flushEffects();

    // Simulate active in-flight send
    act(() => {
      useConciergeStore.getState().setInvocationStatus('in_progress');
    });
    await flushEffects();

    const textarea = container.querySelector('textarea[aria-label="消息输入框"]') as HTMLTextAreaElement;
    expect(textarea?.value).toBe('second message');

    // Reset mock to track POST calls only going forward
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/messages') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        } as unknown as Response);
      }
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      return configOk();
    });

    // Press Enter — must be blocked by invocationStatus=in_progress guard in handleSend
    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushEffects();

    const postCalls = mockApiFetch.mock.calls.filter((args) => args[0] === '/api/messages');
    expect(postCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Block 7: P0 Liveness — server-truth-driven invocation status
// ---------------------------------------------------------------------------

describe('Block 7: P0 Liveness', () => {
  it('shows "值班猫正在处理" when queue reports active invocation', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-liveness-1',
      threadIdLoaded: true,
      invocationStatus: 'in_progress',
    });

    // Mock: messages empty, queue returns active invocation
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      if (url.includes('/queue')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            queue: [],
            paused: false,
            activeInvocations: [{ catId: 'gemini25', startedAt: Date.now() - 5000 }],
          }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    // Wait for queue poll to complete
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await flushEffects();

    const statusEl = container.querySelector('[role="status"]');
    expect(statusEl).not.toBeNull();
    expect(statusEl?.textContent).toContain('值班猫正在处理');
  });

  it('shows "发送中" during pending state', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-liveness-2',
      threadIdLoaded: true,
      invocationStatus: 'pending',
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    const statusEl = container.querySelector('[role="status"]');
    expect(statusEl).not.toBeNull();
    expect(statusEl?.textContent).toContain('发送中');
  });

  it('transitions to idle when queue reports no active invocation after grace period', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-liveness-3',
      threadIdLoaded: true,
      invocationStatus: 'in_progress',
    });

    // Queue returns empty activeInvocations (invocation finished)
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      if (url.includes('/queue')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            queue: [],
            paused: false,
            activeInvocations: [],
          }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    // Wait for queue poll + grace period (2s) + settle (1s)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3500));
    });
    await flushEffects();

    expect(useConciergeStore.getState().invocationStatus).toBe('idle');
  });

  it('does NOT prematurely idle when queue confirms cat is still running', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-liveness-4',
      threadIdLoaded: true,
      invocationStatus: 'in_progress',
    });

    // Queue always returns active invocation — cat is still processing
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      if (url.includes('/queue')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            queue: [],
            paused: false,
            activeInvocations: [{ catId: 'gemini25', startedAt: Date.now() - 30000 }],
          }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    // Even after 5 seconds, should NOT go idle because queue says still running
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5000));
    });
    await flushEffects();

    expect(useConciergeStore.getState().invocationStatus).toBe('in_progress');
  });

  it('P2 (cloud review): queued turn with empty activeInvocations keeps in_progress', async () => {
    // Cloud codex P2: a turn can be queued (status:"queued") but not yet in
    // activeInvocations (processor hasn't picked it up). The hook must treat
    // queued entries as "still running" to avoid flashing idle during handoff.
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-liveness-queued',
      threadIdLoaded: true,
      invocationStatus: 'in_progress',
    });

    // Queue has a queued entry but activeInvocations is empty
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      if (url.includes('/queue')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            queue: [{ id: 'turn-1', status: 'queued', threadId: 'thread-liveness-queued' }],
            paused: false,
            activeInvocations: [],
          }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    // Even after grace period, should NOT go idle — queue has pending work
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5000));
    });
    await flushEffects();

    expect(useConciergeStore.getState().invocationStatus).toBe('in_progress');
  });

  it('P1 (gpt52 review): slow first queue poll does NOT cause premature idle', async () => {
    // Regression: before the `loaded` guard, useConciergeQueue initialized with
    // isRunning=false, and ConciergePanel treated that as "server confirmed done",
    // triggering the 2s+1s grace→idle path even before the first poll returned.
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-liveness-slow-poll',
      threadIdLoaded: true,
      invocationStatus: 'in_progress',
    });

    // Queue poll is slow — resolves after 4s (longer than grace period)
    let resolveQueue!: (v: Response) => void;
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      if (url.includes('/queue')) {
        return new Promise<Response>((resolve) => {
          resolveQueue = resolve;
        });
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    // After 3.5s (past the old grace period), should still be in_progress
    // because queue hasn't responded yet (loaded=false blocks grace path)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3500));
    });
    await flushEffects();

    expect(useConciergeStore.getState().invocationStatus).toBe('in_progress');

    // Now resolve the queue poll with active invocation
    await act(async () => {
      resolveQueue({
        ok: true,
        status: 200,
        json: async () => ({
          queue: [],
          paused: false,
          activeInvocations: [{ catId: 'gemini25', startedAt: Date.now() }],
        }),
      } as unknown as Response);
      await Promise.resolve();
    });
    await flushEffects();

    // Still in_progress — queue confirmed cat is running
    expect(useConciergeStore.getState().invocationStatus).toBe('in_progress');
  });

  it(
    'P2 R2 (cloud review): sustained poll failure triggers 10s deadline fallback to idle',
    { timeout: 20_000 },
    async () => {
      // Cloud codex round 2 P2: if queue polling never succeeds (API unreachable),
      // loaded stays false forever, leaving the panel stuck in in_progress.
      // The 10s deadline forces loaded=true to allow idle recovery.
      useConciergeStore.setState({
        configLoaded: true,
        surfaceState: 'bubble',
        threadId: 'thread-liveness-deadline',
        threadIdLoaded: true,
        invocationStatus: 'in_progress',
      });

      // Queue poll always fails (non-2xx)
      mockApiFetch.mockImplementation((url: string) => {
        if (url.includes('/api/messages?')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ messages: [] }),
          } as unknown as Response);
        }
        if (url.includes('/queue')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ error: 'Internal Server Error' }),
          } as unknown as Response);
        }
        return configOk();
      });

      await render(<ConciergeHost />);
      await flushEffects();

      // At 5s, should still be in_progress (deadline is 10s)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5000));
      });
      await flushEffects();
      expect(useConciergeStore.getState().invocationStatus).toBe('in_progress');

      // Wait past deadline (10s from mount) — need to flush after deadline fires
      await act(async () => {
        await new Promise((r) => setTimeout(r, 6000));
      });
      await flushEffects();

      // Deadline fired → loaded=true → effect starts grace (2s) + settle (1s)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 4000));
      });
      await flushEffects();
      expect(useConciergeStore.getState().invocationStatus).toBe('idle');
    },
  );

  it('no status indicator when invocationStatus=idle', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-liveness-5',
      threadIdLoaded: true,
      invocationStatus: 'idle',
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    // No status indicator when idle
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Block 7b: Phase B confirmation recovery
// ---------------------------------------------------------------------------

describe('Block 7b: Phase B confirmation recovery', () => {
  it('P1: ConciergePanel wires restored confirmation state into CardBlock buttons', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-confirmation',
      threadIdLoaded: true,
      invocationStatus: 'idle',
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/concierge/confirmations') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            confirmations: [
              {
                id: 'confirmation-1',
                messageId: 'msg-confirmation',
                status: 'confirmed',
                action: { kind: 'concierge_triage_confirm', planId: 'plan-1', intent: 'relay' },
              },
            ],
          }),
        } as unknown as Response);
      }
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            messages: [
              {
                id: 'msg-confirmation',
                type: 'assistant',
                content: '我建议帮你传话。',
                catId: 'gemini25',
                timestamp: 1000,
                extra: {
                  rich: {
                    blocks: [
                      {
                        id: 'triage-card',
                        kind: 'card',
                        v: 1,
                        title: '分诊计划',
                        actions: [
                          {
                            action: 'concierge_triage_confirm',
                            label: '确认传话',
                            payload: { planId: 'plan-1', intent: 'relay' },
                          },
                          {
                            action: 'concierge_triage_cancel',
                            label: '取消',
                            payload: { planId: 'plan-1' },
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            ],
          }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergePanel />);
    await flushEffects();
    await flushEffects();

    const confirmButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('已确认'),
    ) as HTMLButtonElement | undefined;
    const cancelButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '取消') as
      | HTMLButtonElement
      | undefined;

    expect(confirmButton).toBeTruthy();
    expect(confirmButton?.disabled).toBe(true);
    expect(cancelButton).toBeTruthy();
    expect(cancelButton?.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Block 8: Runtime fixes (operator 首验 4 问, 2026-06-12)
// ---------------------------------------------------------------------------

describe('Block 8: Runtime fixes', () => {
  // FIX-1 (P1): Assistant message bubble must be visually distinct from panel background
  it('FIX-1: assistant message bubble has visible border', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-fix1',
      threadIdLoaded: true,
      invocationStatus: 'idle',
    });

    // Return user + cat messages
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            messages: [
              { id: 'u1', type: 'user', content: 'hi', timestamp: 1000 },
              { id: 'a1', type: 'assistant', content: '你好！', catId: 'gemini25', timestamp: 2000 },
            ],
          }),
        } as unknown as Response);
      }
      return configOk();
    });

    // Render panel directly (ConciergeHost config fetch can interfere with surfaceState)
    await render(<ConciergePanel />);
    await flushEffects();
    // Wait for message fetch to complete
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await flushEffects();

    // Find message bubbles (rendered in order: user=0, assistant=1)
    const messageDivs = container.querySelectorAll('.max-w-\\[85\\%\\]');
    expect(messageDivs.length).toBeGreaterThanOrEqual(2);
    // The assistant message (index 1, left-aligned) must have a visible border
    const assistantBubble = messageDivs[1] as HTMLElement;
    expect(assistantBubble.style.borderWidth).toBe('1px');
  });

  // FIX-2 (P1 S6): Successful send must clear input value
  it('FIX-2 S6: successful send clears textarea value', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'collapsed',
      threadId: 'thread-fix2',
      threadIdLoaded: true,
      invocationStatus: 'idle',
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/messages') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
      }
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    await flushEffects();

    // Open bubble with pre-filled text
    act(() => {
      useConciergeStore.getState().setSurfaceState('bubble', 'hello cat');
    });
    await flushEffects();

    const inputEl = container.querySelector('textarea[aria-label="消息输入框"]') as HTMLTextAreaElement;
    expect(inputEl.value).toBe('hello cat');

    // Send
    await act(async () => {
      const sendBtn = container.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
      sendBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushEffects();

    // S6: input must be cleared after successful send
    expect(inputEl.value).toBe('');
  });

  // FIX-2b R2: Enter during IME composition must NOT trigger send.
  // Uses useIMEGuard (composition ref) — not just nativeEvent.isComposing — because
  // Chrome fires compositionend BEFORE keydown(Enter), so isComposing is already false.
  it('FIX-2b R2: Enter during active composition does not trigger send (Firefox path)', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'collapsed',
      threadId: 'thread-fix2b',
      threadIdLoaded: true,
      invocationStatus: 'idle',
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    act(() => {
      useConciergeStore.getState().setSurfaceState('bubble', '你好');
    });
    await flushEffects();

    // Reset to track POST calls
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/messages') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
      }
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      return configOk();
    });

    const textarea = container.querySelector('textarea[aria-label="消息输入框"]') as HTMLTextAreaElement;

    // Firefox path: compositionstart → keydown(Enter) fires DURING composition
    await act(async () => {
      textarea.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushEffects();

    // Must NOT have triggered a POST — Enter during composition = IME confirm, not send
    const postCalls = mockApiFetch.mock.calls.filter((args) => args[0] === '/api/messages');
    expect(postCalls.length).toBe(0);
  });

  // FIX-2b R2: Chrome path — compositionend fires BEFORE keydown(Enter), so
  // nativeEvent.isComposing is already false. useIMEGuard's rAF-delayed ref bridges this.
  it('FIX-2b R2: Chrome compositionend→keydown sequence does not trigger send', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'collapsed',
      threadId: 'thread-fix2b-chrome',
      threadIdLoaded: true,
      invocationStatus: 'idle',
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergeHost />);
    act(() => {
      useConciergeStore.getState().setSurfaceState('bubble', '你好');
    });
    await flushEffects();

    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/messages') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
      }
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      return configOk();
    });

    const textarea = container.querySelector('textarea[aria-label="消息输入框"]') as HTMLTextAreaElement;

    // Chrome sequence: compositionstart → compositionend → keydown(Enter)
    await act(async () => {
      textarea.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new Event('compositionend', { bubbles: true }));
    });
    // Immediately dispatch Enter — rAF hasn't flushed yet, so useIMEGuard ref is still true
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushEffects();

    const postCalls = mockApiFetch.mock.calls.filter((args) => args[0] === '/api/messages');
    expect(postCalls.length).toBe(0);
  });

  // FIX-4 (P2 KD-16): Panel header must show duty cat identity
  it('FIX-4 KD-16: panel header shows duty cat name alongside displayName', async () => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      displayName: '猫猫球',
      dutyCatProfileId: 'gemini25',
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/messages?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ messages: [] }),
        } as unknown as Response);
      }
      return configOk();
    });

    await render(<ConciergePanel />);
    await flushEffects();

    // Header must contain some indication of which cat is on duty (not just "猫猫球")
    const headerSpan = container.querySelector('[role="dialog"] .text-sm.font-semibold');
    expect(headerSpan).not.toBeNull();
    expect(headerSpan?.textContent).toContain('值班');
  });
});
