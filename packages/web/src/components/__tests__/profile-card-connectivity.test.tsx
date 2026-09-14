import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ProfileCard's connectivity-result states.
 *
 * `unverified` is a third state, not a flavour of failure. The server answers
 * `{ok: true, skipped: true}` when it has no probe spec for the CLI, and the card used to render
 * that as a pass — letting the user through the connectivity gate having verified nothing. Once
 * the wizard started sending the resolved binary, that path became reachable for google members
 * (whose tool id is `agy`, for which no probe spec exists).
 *
 * What must hold: unverified is neither green nor red, it does not claim a pass, and it offers an
 * explicit way forward rather than dead-ending the wizard.
 */

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const baseProfile = {
  id: 'gemini',
  provider: 'google',
  displayName: 'Gemini',
  name: 'Gemini',
  authType: 'oauth' as const,
  kind: 'builtin' as const,
  builtin: true,
  mode: 'subscription' as const,
  clientId: 'google' as const,
  hasApiKey: false,
  models: ['Gemini 3.1 Pro (High)'],
  createdAt: '',
  updatedAt: '',
};

describe('ProfileCard connectivity states', () => {
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

  async function render(
    testResult: { ok: boolean; unverified?: boolean; acknowledged?: boolean; message?: string } | null,
    onAcknowledge?: () => void,
  ) {
    const { ProfileCard } = await import('../first-run-quest/ProfileCard');
    await act(async () => {
      root.render(
        React.createElement(ProfileCard, {
          profile: baseProfile,
          isSelected: true,
          isExpanded: true,
          selectedModel: 'Gemini 3.1 Pro (High)',
          testing: false,
          testResult,
          onSelect: () => {},
          onModelSelect: () => {},
          onTest: () => {},
          ...(onAcknowledge ? { onAcknowledge } : {}),
          onProfileRefresh: () => {},
          onEdit: () => {},
        }),
      );
    });
  }

  it('renders an unverified probe as neither a pass nor a failure', async () => {
    await render({ ok: false, unverified: true, message: 'agy 不支持连接探测，已跳过检测' });

    expect(container.textContent).toContain('未验证');
    expect(container.textContent).toContain('agy 不支持连接探测');
    expect(container.textContent).not.toContain('已通过');
    // A failure would be red; unverified must not borrow that styling.
    expect(container.querySelector('.text-conn-red-text')).toBeNull();
    expect(container.querySelector('.text-conn-amber-text')).toBeTruthy();
  });

  it('offers an explicit acknowledgement instead of dead-ending the wizard', async () => {
    const onAcknowledge = vi.fn();
    await render({ ok: false, unverified: true, message: '已跳过检测' }, onAcknowledge);

    const button = [...container.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('我已在终端确认可用'),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it('drops the acknowledgement button once the user has acknowledged', async () => {
    await render({ ok: false, unverified: true, acknowledged: true, message: '已跳过检测' }, () => {});

    expect(container.textContent).not.toContain('我已在终端确认可用');
  });

  it('still reports a real pass as a pass', async () => {
    await render({ ok: true, message: '连接成功！' });

    expect(container.textContent).toContain('已通过');
    expect(container.textContent).not.toContain('未验证');
    expect(container.querySelector('.text-conn-green-text')).toBeTruthy();
  });

  it('still reports a real failure as a failure', async () => {
    await render({ ok: false, message: 'CLI 调用失败 (exit 1)' });

    expect(container.textContent).toContain('测试连接');
    expect(container.textContent).toContain('CLI 调用失败');
    expect(container.querySelector('.text-conn-red-text')).toBeTruthy();
  });
});
