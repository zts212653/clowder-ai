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
      // Phase D P2 fix: classifier-known path → excerptSource='classifier' (matches backend builder)
      excerptSource: 'classifier',
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
    // Phase D P2 fix: classifier-known path → excerptSource='classifier' (matches backend builder)
    const diag = build({ reasonCode: 'auth_failed', excerptSource: 'classifier', safeExcerpt: excerpt });

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

  // 砚砚 review P1-2 (2026-05-27) → Phase D refinement (2026-05-29 cloud codex P2 fix):
  // KD-1 white-list moved from reasonCode-only to excerptSource-based. Malformed/persisted
  // payload that retains safeExcerpt WITHOUT excerptSource MUST still suppress disclosure —
  // frontend is last line of defense + forward-compat for unknown future sources.
  it('KD-1 front-end defense: safeExcerpt present but excerptSource undefined → toggle still hidden (malformed payload guard)', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const diag = build({
      // no reasonCode + no excerptSource — simulates malformed/persisted payload
      safeExcerpt: 'Stale stderr that should not leak through the UI',
      publicSummary: '未识别的 CLI 错误',
      publicHint: '详细诊断信息见后端日志',
    });
    // intentionally no excerptSource — caller forgot OR payload is malformed/old

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

  // F212 Phase D — Cloud codex P2 fix (2026-05-29, on a429aada3):
  // AC-D3 unknown fallback produces safeExcerpt with excerptSource='cc_structured' (CC
  // emitted a structured result error that the classifier didn't recognize but is safe
  // to surface — KD-1 white-list admission via source channel rather than reasonCode).
  // Frontend MUST render the disclosure even when reasonCode is undefined, otherwise
  // users see only the 200-char publicSummary and lose the multiline CC cause.
  it('AC-D3 (Phase D P2 fix): excerptSource=cc_structured renders toggle even when reasonCode undefined', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const ccCause = "The model's tool call could not be parsed (retry also failed).";
    const diag = build({
      // no reasonCode (AC-D3 unknown) but CC structured error came through safely
      excerptSource: 'cc_structured',
      safeExcerpt: ccCause,
      publicSummary: `Claude Code 报告：${ccCause}`,
      publicHint: '这是 Claude Code / 模型侧报告的错误，不是猫咖问题。',
    });

    act(() => {
      root.render(
        React.createElement(CliDiagnosticsPanel, {
          errorMessage: 'Error: CLI 异常退出',
          diagnostics: diag,
        }),
      );
    });

    const toggle = container.querySelector('[data-testid="cli-diagnostics-toggle"]') as HTMLButtonElement;
    expect(toggle, 'AC-D3 path must expose excerpt toggle when excerptSource is whitelisted').toBeTruthy();

    act(() => {
      toggle.click();
    });

    const excerptEl = container.querySelector('[data-testid="cli-diagnostics-excerpt"]');
    expect(excerptEl).toBeTruthy();
    expect(excerptEl?.textContent).toBe(ccCause);
  });

  // Forward-compat defense (cloud codex P2 fix 2026-05-29, second leg of KD-1 belt-and-braces):
  // Newer api ships an excerptSource value the current web doesn't know (e.g. a hypothetical
  // 'pii_redacted'). Old client must fail closed — only KNOWN sources unlock disclosure.
  // This complements the malformed-payload guard above; together they cover both directions
  // of api/web version skew.
  it('Forward-compat: unknown excerptSource value → toggle hidden even with safeExcerpt', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const diag = build({
      excerptSource: 'pii_redacted' as unknown as CliDiagnostics['excerptSource'],
      safeExcerpt: 'A future source the current web does not understand',
      publicSummary: 'A future error',
      publicHint: 'A future hint',
    });

    act(() => {
      root.render(
        React.createElement(CliDiagnosticsPanel, {
          errorMessage: 'Error: future',
          diagnostics: diag,
        }),
      );
    });

    // unknown source → membership check rejects → no disclosure (defense-in-depth)
    expect(container.querySelector('[data-testid="cli-diagnostics-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="cli-diagnostics-excerpt"]')).toBeNull();
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
      'tool_call_parse_failed',
      'server_overloaded',
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
      { command: '/home/user/codex --json', expectIn: '~/codex', expectNotIn: 'user' },
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

  it('debugRef strip surfaces path-safe provider spawn context', async () => {
    const { CliDiagnosticsPanel } = await import('../CliDiagnosticsPanel');
    const diag = build({
      reasonCode: 'auth_failed',
      debugRef: {
        command: 'agy',
        exitCode: 0,
        signal: null,
        invocationId: 'inv-agy-auth',
        homeMode: 'agy_profile_home',
        spawnCwdMode: 'agy_profile_cwd',
        spawnCwdKey: '230809973b9c83ac',
        profileId: 'f210-gemini35-flash-high',
      },
    });

    act(() => {
      root.render(
        React.createElement(CliDiagnosticsPanel, {
          errorMessage: 'Error: auth failed',
          diagnostics: diag,
        }),
      );
    });

    const ref = container.querySelector('[data-testid="cli-diagnostics-debug-ref"]');
    expect(ref?.textContent).toContain('homeMode:');
    expect(ref?.textContent).toContain('agy_profile_home');
    expect(ref?.textContent).toContain('spawnCwdMode:');
    expect(ref?.textContent).toContain('agy_profile_cwd');
    expect(ref?.textContent).toContain('spawnCwdKey:');
    expect(ref?.textContent).toContain('230809973b9c83ac');
    expect(ref?.textContent).toContain('profileId:');
    expect(ref?.textContent).toContain('f210-gemini35-flash-high');
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

  // F212 follow-up — codex R3 catch (PR #1967, b304a27d2): biome --write --unsafe via
  // lint/suspicious/noPrototypeBuiltins rewrites Object.prototype.hasOwnProperty.call
  // to Object.hasOwn, which is ES2022 (Safari/iOS <15.4 not supported). The Panel
  // tsconfig target is ES2017, so this would crash any CLI error render on older
  // Safari. Source-level invariance check defends against future biome rule rename
  // making the inline biome-ignore comment a no-op.
  it('isKnownReason source stays on Object.prototype.hasOwnProperty.call (ES2017 compat invariance)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const panelPath = path.resolve(here, '..', 'CliDiagnosticsPanel.tsx');
    const src = await fs.readFile(panelPath, 'utf8');
    // Positive: the safe form must be present
    expect(src).toContain('Object.prototype.hasOwnProperty.call(REASON_PALETTE');
    // Negative: the ES2022 form (which biome --unsafe rewrites to) must NOT appear in
    // the runtime path. Comments mentioning it are fine; we only guard the actual call.
    const codeLines = src.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    const runtimeCode = codeLines.join('\n');
    expect(runtimeCode).not.toMatch(/Object\.hasOwn\s*\(/);
  });
});
