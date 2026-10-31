import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('F118 TimeoutDiagnosticsPanel (AC-C3)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders error banner and diagnostics section', async () => {
    const { TimeoutDiagnosticsPanel } = await import('../TimeoutDiagnosticsPanel');

    const diag = {
      silenceDurationMs: 1800000,
      processAlive: true,
      lastEventType: 'thread.started',
      firstEventAt: 1710394915000,
      lastEventAt: 1710394915000,
      cliSessionId: '019cec11-32cf-74b2-af27-469c4364abcd',
      invocationId: '6c521978-b5ea-439d-b03b-52444ac4efgh',
      rawArchivePath: '/data/cli-raw-archive/2026-03-14/6c52...',
    };

    act(() => {
      root.render(
        React.createElement(TimeoutDiagnosticsPanel, {
          errorMessage: '缅因猫 CLI 响应超时 (1800s)',
          diagnostics: diag,
        }),
      );
    });

    const el = container.querySelector('[data-testid="timeout-diagnostics"]');
    expect(el).toBeTruthy();
    // Error banner
    expect(el?.textContent).toContain('CLI 响应超时');
    // Diagnostics toggle
    expect(el?.textContent).toContain('Diagnostics');
  });

  it('a standalone timeout retains its error and folded diagnostics', async () => {
    const { TerminalDiagnosticsPanel } = await import('../TerminalDiagnosticsPanel');
    act(() => {
      root.render(
        React.createElement(TerminalDiagnosticsPanel, {
          selected: {
            kind: 'timeout',
            diagnostics: { silenceDurationMs: 1846576, processAlive: true, invocationId: 'timed-out-turn' },
          },
          errorMessage: '回复失败。',
        }),
      );
    });
    const panel = container.querySelector('[data-testid="timeout-diagnostics"]');
    expect(panel?.textContent).toContain('回复失败。');
    expect(panel?.textContent).toContain('Diagnostics');
    expect(container.querySelector('[data-testid="diagnostics-panel"]')).toBeNull();
    const toggle = container.querySelector('[data-testid="diagnostics-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.textContent).toContain('timed-out-turn');
    expect(panel?.textContent).toContain('1846576ms');
    expect(panel?.textContent).toContain('true (at timeout)');
    expect(panel?.textContent).toContain('回复失败。');
  });

  it('a standalone classified CLI error retains its actionable cause and hint', async () => {
    const { TerminalDiagnosticsPanel } = await import('../TerminalDiagnosticsPanel');
    act(() => {
      root.render(
        React.createElement(TerminalDiagnosticsPanel, {
          selected: {
            kind: 'cli',
            diagnostics: {
              reasonCode: 'auth_failed',
              publicSummary: 'API 认证失败',
              publicHint: '检查 API key',
              debugRef: { command: 'codex', exitCode: 1, signal: null },
            },
          },
          errorMessage: '回复失败。',
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-diagnostics-banner"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="cli-diagnostics"]')?.textContent).toContain('API 认证失败');
    expect(container.querySelector('[data-testid="cli-diagnostics"]')?.textContent).toContain('检查 API key');
    expect(container.querySelector('[data-testid="timeout-diagnostics"]')).toBeNull();
  });

  it('expands diagnostics on click', async () => {
    const { TimeoutDiagnosticsPanel } = await import('../TimeoutDiagnosticsPanel');

    const diag = {
      silenceDurationMs: 1800000,
      processAlive: true,
      lastEventType: 'thread.started',
      firstEventAt: 1710394915000,
      lastEventAt: 1710394915000,
    };

    act(() => {
      root.render(
        React.createElement(TimeoutDiagnosticsPanel, {
          errorMessage: 'CLI 响应超时 (1800s)',
          diagnostics: diag,
        }),
      );
    });

    // Click the diagnostics toggle
    const toggle = container.querySelector('[data-testid="diagnostics-toggle"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();

    act(() => {
      toggle.click();
    });

    // Diagnostics rows should now be visible
    const panel = container.querySelector('[data-testid="diagnostics-panel"]');
    expect(panel).toBeTruthy();
    expect(panel?.textContent).toContain('silenceDuration');
    expect(panel?.textContent).toContain('processAlive');
    expect(panel?.textContent).toContain('true');
  });
});
