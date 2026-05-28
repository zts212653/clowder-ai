import type { CliDiagnostics, CliErrorReasonCode } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * F212 Phase B — CliDiagnosticsPanel rendering contract.
 *
 * Mirrors `ChatMessage-timeout-diagnostics.test.ts` structure. Covers AC-B2/B3/B4:
 *   - B2: panel renders + safeExcerpt collapsed by default
 *   - B3: publicSummary / publicHint always visible; safeExcerpt only after toggle
 *   - B4: every reasonCode gets a distinct accent (icon aria-label is the reasonCode)
 *   - Fallback: undefined reasonCode renders unknown-icon banner with publicSummary
 */

describe('F212 CliDiagnosticsPanel (AC-B2/B3/B4)', () => {
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

  function build(overrides: Partial<CliDiagnostics> = {}): CliDiagnostics {
    return {
      publicSummary: '模型名不被支持',
      publicHint: '检查 CLI 配置里的模型名拼写',
      debugRef: {
        command: 'codex',
        exitCode: 1,
        signal: null,
        invocationId: '019cec11-32cf-74b2-af27-469c4364abcd',
      },
      ...overrides,
    };
  }

  it('AC-B2/B3: renders banner with summary + hint, excerpt hidden by default', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const diag = build({
      reasonCode: 'model_not_found',
      safeExcerpt: 'Error: deepseek-v-4 is not a supported model.\nSupported: deepseek-v4-pro / deepseek-v4-flash',
    });

    act(() => {
      root.render(
        React.createElement(CliDiagnosticsPanel, {
          errorMessage: 'Error: CLI 异常退出 (code: 1)',
          diagnostics: diag,
        }),
      );
    });

    const banner = container.querySelector('[data-testid="cli-diagnostics-banner"]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('模型名不被支持');
    expect(banner?.textContent).toContain('检查 CLI 配置里的模型名拼写');

    // safeExcerpt content not rendered yet — only its toggle is visible
    expect(container.querySelector('[data-testid="cli-diagnostics-excerpt"]')).toBeNull();
    const toggle = container.querySelector('[data-testid="cli-diagnostics-toggle"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.textContent).toContain('查看详细错误');
  });

  it('AC-B3: clicking toggle reveals safeExcerpt verbatim', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const excerpt = '401 Unauthorized: invalid api key\nHint: check ANTHROPIC_API_KEY';
    const diag = build({ reasonCode: 'auth_failed', safeExcerpt: excerpt });

    act(() => {
      root.render(
        React.createElement(CliDiagnosticsPanel, {
          errorMessage: 'Error: auth failed',
          diagnostics: diag,
        }),
      );
    });

    const toggle = container.querySelector('[data-testid="cli-diagnostics-toggle"]') as HTMLButtonElement;
    act(() => {
      toggle.click();
    });
    const excerptEl = container.querySelector('[data-testid="cli-diagnostics-excerpt"]');
    expect(excerptEl).toBeTruthy();
    expect(excerptEl?.textContent).toBe(excerpt);
  });

  it('AC-B3: panel hides toggle entirely when safeExcerpt absent (KD-1 unknown stderr)', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    // unknown stderr: no reasonCode, no safeExcerpt — KD-1 white-list admission
    const diag = build({
      publicSummary: '未识别的 CLI 错误',
      publicHint: '详细诊断信息见后端日志',
    });

    act(() => {
      root.render(
        React.createElement(CliDiagnosticsPanel, {
          errorMessage: 'Error: CLI 异常退出',
          diagnostics: diag,
        }),
      );
    });

    expect(container.querySelector('[data-testid="cli-diagnostics-banner"]')?.textContent).toContain(
      '未识别的 CLI 错误',
    );
    // No toggle, no excerpt — KD-1 hides the disclosure entirely
    expect(container.querySelector('[data-testid="cli-diagnostics-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="cli-diagnostics-excerpt"]')).toBeNull();
  });

  // 砚砚 review P1-2 (2026-05-27): KD-1 white-list admission MUST gate on reasonCode too.
  // Malformed/persisted payload that retains safeExcerpt without reasonCode should still
  // suppress the excerpt disclosure — front-end is the last line of defense.
  it('KD-1 front-end defense: safeExcerpt present but reasonCode absent → toggle still hidden (P1-2 guard)', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const diag = build({
      // no reasonCode — simulates malformed/persisted payload
      safeExcerpt: 'Stale stderr that should not leak through the UI',
      publicSummary: '未识别的 CLI 错误',
      publicHint: '详细诊断信息见后端日志',
    });

    act(() => {
      root.render(
        React.createElement(CliDiagnosticsPanel, {
          errorMessage: 'Error: CLI 异常退出',
          diagnostics: diag,
        }),
      );
    });

    // Disclosure suppressed even though safeExcerpt is non-empty (KD-1 belt-and-braces)
    expect(container.querySelector('[data-testid="cli-diagnostics-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="cli-diagnostics-excerpt"]')).toBeNull();
    expect(container.textContent).not.toContain('Stale stderr');
  });

  it('AC-B4: every reasonCode maps to a distinct icon aria-label (= reasonCode itself)', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const reasonCodes: CliErrorReasonCode[] = [
      'auth_failed',
      'invalid_config',
      'model_not_found',
      'quota_exceeded',
      'network_error',
      'spawn_failed',
      'missing_rollout',
      'context_window_exceeded',
      'invalid_thinking_signature',
    ];

    for (const reasonCode of reasonCodes) {
      const diag = build({ reasonCode });
      act(() => {
        root.render(
          React.createElement(CliDiagnosticsPanel, {
            errorMessage: 'Error: x',
            diagnostics: diag,
          }),
        );
      });
      const icon = container.querySelector(`svg[aria-label="${reasonCode}"]`);
      expect(icon, `Missing svg icon for reasonCode=${reasonCode}`).toBeTruthy();
    }
  });

  it('AC-B4 fallback: undefined reasonCode renders cli-error-unknown icon', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const diag = build(); // no reasonCode

    act(() => {
      root.render(
        React.createElement(CliDiagnosticsPanel, {
          errorMessage: 'Error: x',
          diagnostics: diag,
        }),
      );
    });

    const icon = container.querySelector('svg[aria-label="cli-error-unknown"]');
    expect(icon).toBeTruthy();
  });

  // 云端 codex P2 (2026-05-27): unknown reasonCode strings (e.g. older client fetches a
  // newer-api error, hydration from a future server, malformed persisted payload) MUST
  // fall through to UNKNOWN_PALETTE instead of crashing the chat render with a destructure
  // of `undefined`. Also suppresses excerpt disclosure (membership-gated KD-1).
  it('membership defense: unknown reasonCode string renders unknown variant + hides excerpt (P2 guard)', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    // Bypass CliErrorReasonCode union via deliberate cast — simulates a payload that
    // crossed a version boundary (newer api → older web, or persisted from future client).
    const diag = {
      reasonCode: 'rate_limited_concurrent_future_code',
      publicSummary: 'Rate-limited (newer API)',
      publicHint: 'Wait and retry',
      safeExcerpt: 'detail-text that must NOT leak when reasonCode is non-member',
      debugRef: { command: 'codex', exitCode: 1, signal: null },
    } as unknown as CliDiagnostics;

    // Must not throw on destructure of `palette = REASON_PALETTE[unknown_code]`
    expect(() => {
      act(() => {
        root.render(
          React.createElement(CliDiagnosticsPanel, {
            errorMessage: 'Error: x',
            diagnostics: diag,
          }),
        );
      });
    }).not.toThrow();

    // Banner uses fallback unknown icon
    expect(container.querySelector('svg[aria-label="cli-error-unknown"]')).toBeTruthy();
    // Banner still shows summary text
    expect(container.querySelector('[data-testid="cli-diagnostics-banner"]')?.textContent).toContain(
      'Rate-limited (newer API)',
    );
    // Excerpt disclosure suppressed (membership-gated)
    expect(container.querySelector('[data-testid="cli-diagnostics-toggle"]')).toBeNull();
    expect(container.textContent).not.toContain('detail-text');
  });

  // 云端 codex P2-5 (2026-05-27): debugRef.command may carry absolute paths from
  // resolveCliCommand()'s which/home fallbacks; api sanitizer covers stderr but not the
  // structured field. Frontend mirrors the redaction before rendering.
  it('P2-5 path redaction: macOS/Linux/Windows home paths in command sanitized to ~', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const fixtures = [
      { command: '/home/user/codex --json', expectIn: '~/.npm/bin/codex', expectNotIn: 'you' },
      { command: '/home/alice/.local/bin/claude', expectIn: '~/.local/bin/claude', expectNotIn: 'alice' },
      { command: 'C:\\Users\\bob\\AppData\\codex.exe', expectIn: '~\\AppData\\codex.exe', expectNotIn: 'bob' },
      // 云端 codex P2-6 (round-6): Linux root home (container/server installs)
      { command: '/root/.npm/bin/codex', expectIn: '~/.npm/bin/codex', expectNotIn: '/root' },
      // 云端 codex P2-6: macOS root
      { command: '/var/root/.local/codex', expectIn: '~/.local/codex', expectNotIn: '/var/root' },
    ];

    for (const { command, expectIn, expectNotIn } of fixtures) {
      const diag = build({ reasonCode: 'spawn_failed', debugRef: { command, exitCode: 1, signal: null } });
      act(() => {
        root.render(
          React.createElement(CliDiagnosticsPanel, {
            errorMessage: 'Error: spawn failed',
            diagnostics: diag,
          }),
        );
      });
      const ref = container.querySelector('[data-testid="cli-diagnostics-debug-ref"]');
      expect(ref?.textContent, `command="${command}"`).toContain(expectIn);
      expect(ref?.textContent, `command="${command}" must not contain "${expectNotIn}"`).not.toContain(expectNotIn);
    }
  });

  it('debugRef strip surfaces command + exit + signal + invocationId (truncated)', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const diag = build({
      reasonCode: 'spawn_failed',
      debugRef: {
        command: 'codex --json-stream --model gpt-5.5-codex',
        exitCode: null,
        signal: 'SIGTERM',
        invocationId: '019cec11-32cf-74b2-af27-469c4364abcd-extra-tail',
      },
    });

    act(() => {
      root.render(
        React.createElement(CliDiagnosticsPanel, {
          errorMessage: 'Error: spawn failed',
          diagnostics: diag,
        }),
      );
    });

    const ref = container.querySelector('[data-testid="cli-diagnostics-debug-ref"]');
    expect(ref?.textContent).toContain('command:');
    expect(ref?.textContent).toContain('exit:');
    expect(ref?.textContent).toContain('null'); // exitCode null path
    expect(ref?.textContent).toContain('signal:');
    expect(ref?.textContent).toContain('SIGTERM');
    expect(ref?.textContent).toContain('invocationId:');
    // truncation: middle ellipsis "…" present for long invocationId
    expect(ref?.textContent).toMatch(/…/);
  });

  it('falls back to errorMessage when publicSummary is empty', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const diag = build({ publicSummary: '' });

    act(() => {
      root.render(
        React.createElement(CliDiagnosticsPanel, {
          errorMessage: 'Error: unexpected',
          diagnostics: diag,
        }),
      );
    });

    expect(container.querySelector('[data-testid="cli-diagnostics-banner"]')?.textContent).toContain(
      'Error: unexpected',
    );
  });
});
