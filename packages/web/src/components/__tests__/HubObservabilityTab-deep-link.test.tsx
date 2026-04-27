/**
 * F174 D2b-3 — cloud Codex P1 #1403 regression: HubObservabilityTab must
 * react to `initialSubTab` prop changes after mount, otherwise a second
 * `openHub('observability', 'callback-auth')` while the Hub is already
 * open on the Observability tab silently fails to switch subTab — the
 * 详情 button on D2b-1 would feel broken on the second click.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// Stub heavy children — we only test the subtab routing.
vi.mock('../HubCallbackAuthPanel', () => ({
  HubCallbackAuthPanel: () => <div data-testid="callback-auth-panel">callback-auth-panel</div>,
}));
vi.mock('../HubTraceTree', () => ({
  TraceBrowser: () => <div data-testid="trace-browser">trace-browser</div>,
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { HubObservabilityTab } from '../HubObservabilityTab';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('HubObservabilityTab deep-link sync (F174 D2b-3 cloud P1 #1403)', () => {
  it('switches active subtab when initialSubTab prop changes after mount', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // First render: open into overview (default).
    await act(async () => {
      root.render(<HubObservabilityTab initialSubTab="overview" />);
    });
    // overview is active — callback-auth panel not rendered.
    expect(container.querySelector('[data-testid="callback-auth-panel"]')).toBeNull();

    // Simulate D2b-1 详情 button click while Hub is already open: prop
    // changes from 'overview' → 'callback-auth'. WITHOUT the fix, useState
    // initializer doesn't re-run, so subTab stays 'overview' and the panel
    // stays hidden — bug.
    await act(async () => {
      root.render(<HubObservabilityTab initialSubTab="callback-auth" />);
    });

    expect(container.querySelector('[data-testid="callback-auth-panel"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Cloud P2 + 砚砚 P2 #1403: same initialSubTab value + new nonce after manual subtab switch re-syncs', async () => {
    // 砚砚 P2 — true reproduction of cloud's bug, designed so that DELETING
    // `subTabNonce` from useEffect deps in the implementation makes this test
    // FAIL. Sequence:
    //   1. render initialSubTab='callback-auth' nonce=1 → panel visible
    //   2. user CLICKS '总览' tab button → internal subTab='overview', PARENT
    //      prop still 'callback-auth' (hubState.subTab unchanged)
    //   3. re-render with same initialSubTab='callback-auth' but nonce=2
    //      (= second 详情 click). Without nonce dep, useEffect saw the same
    //      value and would NOT re-sync — user stays on '总览'. With nonce dep,
    //      setSubTab('callback-auth') fires and panel returns.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // Step 1: first deep-link.
    await act(async () => {
      root.render(<HubObservabilityTab initialSubTab="callback-auth" subTabNonce={1} />);
    });
    expect(container.querySelector('[data-testid="callback-auth-panel"]')).not.toBeNull();

    // Step 2: simulate the user clicking the '总览' subtab button so internal
    // subTab moves away from 'callback-auth' WITHOUT touching the prop.
    const overviewButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '总览');
    expect(overviewButton, 'overview button must exist').toBeTruthy();
    await act(async () => {
      overviewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    // overview is active — callback-auth panel hidden, internal state diverged from prop.
    expect(container.querySelector('[data-testid="callback-auth-panel"]')).toBeNull();

    // Step 3: second deep-link with SAME initialSubTab value but new nonce.
    // This is the critical case — exact bug cloud Codex flagged.
    await act(async () => {
      root.render(<HubObservabilityTab initialSubTab="callback-auth" subTabNonce={2} />);
    });
    // Without nonce dep this fails — user stays on '总览' even though they
    // clicked 详情 again.
    expect(container.querySelector('[data-testid="callback-auth-panel"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('initialSubTab=undefined defaults to overview on first mount', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<HubObservabilityTab />);
    });
    expect(container.querySelector('[data-testid="callback-auth-panel"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
