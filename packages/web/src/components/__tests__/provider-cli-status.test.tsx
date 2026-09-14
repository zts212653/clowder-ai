import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberCliDispatch } from '../hub-cat-editor.model';

/**
 * ProviderCliStatus rendering contract.
 *
 * Four things are being defended:
 *
 *  1. **No request on mount.** A self-fetching child runs its effect before its parent's
 *     (React effects are bottom-up), so mounting this card inside the member editor injected a
 *     request ahead of the editor's own and consumed the response the editor had queued —
 *     which broke `hub-cat-editor.test.tsx`. Detection is click-triggered instead.
 *  2. **Unknown is never rendered as "not installed".** Painting a working CLI as missing
 *     would send the user to reinstall something they already have.
 *  3. **Only standard-CLI members get a verdict.** A cloud member spawns no local CLI and an
 *     ACP member spawns a user-configured command the probe never inspects, so a clientId-level
 *     answer would be wrong for both — in opposite directions.
 *  4. **A failed re-check keeps the previous result.** The refresh endpoint is owner-gated, so a
 *     403 is an expected outcome for a non-owner, not a reason to blank a good report.
 */

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

function provider(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'anthropic',
    toolId: 'claude',
    label: 'Claude',
    installed: true,
    command: 'claude',
    resolvedPath: '/usr/local/bin/claude',
    resolvedVia: 'path',
    hasApiKey: false,
    status: 'configured',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    localCli: true,
    ...overrides,
  };
}

function okResponse(providers: unknown[], ageMs: number | null = 0) {
  return { ok: true, status: 200, json: async () => ({ providers, ageMs }) };
}

const CLI_DISPATCH: MemberCliDispatch = { kind: 'cli' };

describe('ProviderCliStatus', () => {
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
    apiFetchMock.mockReset();
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

  async function render(clientId = 'anthropic', dispatch: MemberCliDispatch = CLI_DISPATCH) {
    const { ProviderCliStatus } = await import('../ProviderCliStatus');
    await act(async () => {
      root.render(React.createElement(ProviderCliStatus, { clientId, dispatch }));
    });
  }

  async function clickButton(label: string) {
    const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(label));
    expect(button, `missing button "${label}"`).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  async function renderAndDetect(clientId = 'anthropic') {
    await render(clientId);
    await clickButton('检测本机 CLI');
  }

  it('does not touch the network until the user asks', async () => {
    apiFetchMock.mockResolvedValue(okResponse([provider()]));
    await render();

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('检测本机 CLI');

    await clickButton('检测本机 CLI');
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/clients');
  });

  it('shows the resolved path for an installed client', async () => {
    apiFetchMock.mockResolvedValue(okResponse([provider()]));
    await renderAndDetect();

    expect(container.textContent).toContain('已安装');
    expect(container.textContent).toContain('/usr/local/bin/claude');
    expect(container.textContent).toContain('本机已安装：Claude');
  });

  it('hands over the install command for a missing client', async () => {
    apiFetchMock.mockResolvedValue(
      okResponse([provider({ installed: false, status: 'missing', resolvedPath: undefined, reason: '未在本机找到' })]),
    );
    await renderAndDetect();

    expect(container.textContent).toContain('未安装');
    expect(container.textContent).toContain('npm install -g @anthropic-ai/claude-code');
    expect(container.textContent).toContain('本机未检测到任何本地 CLI');
  });

  it('never reports a failed request as "not installed"', async () => {
    apiFetchMock.mockRejectedValue(new Error('offline'));
    await renderAndDetect();

    expect(container.textContent).toContain('本机 CLI 状态不可用');
    expect(container.textContent).not.toContain('未安装');
  });

  it('treats a 4xx/5xx response as unknown too', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await renderAndDetect();

    expect(container.textContent).toContain('本机 CLI 状态不可用');
    expect(container.textContent).not.toContain('未安装');
  });

  it('offers a retry after a failed load', async () => {
    // Detection is click-triggered, so without this the user is stuck for the rest of the mount.
    apiFetchMock.mockRejectedValueOnce(new Error('offline'));
    await renderAndDetect();
    expect(container.textContent).toContain('本机 CLI 状态不可用');

    apiFetchMock.mockResolvedValueOnce(okResponse([provider()]));
    await clickButton('重试');

    expect(container.textContent).toContain('已安装');
    expect(container.textContent).not.toContain('本机 CLI 状态不可用');
  });

  it('shows how old the report is', async () => {
    apiFetchMock.mockResolvedValue(okResponse([provider()], 45 * 60_000));
    await renderAndDetect();

    expect(container.textContent).toContain('报告时间：45 分钟前');
  });

  it('names the resolved binary and says the runtime decides what actually runs', async () => {
    // "已安装" is a claim about this machine, not about this member: a provider adapter can spawn a
    // different candidate than the one that resolved here. The card must not let the green pill
    // read as "this member will work".
    apiFetchMock.mockResolvedValue(okResponse([provider()]));
    await renderAndDetect();

    expect(container.textContent).toContain('本机解析到：claude');
    expect(container.textContent).toContain('该成员实际执行的二进制由运行时决定');
  });

  it('names the client default when the resolved candidate differs from it', async () => {
    // google's canonical command is `agy`; a machine with only the legacy CLI resolves `gemini`.
    apiFetchMock.mockResolvedValue(
      okResponse([
        provider({ clientId: 'google', toolId: 'agy', label: 'Gemini', command: 'gemini', status: 'configured' }),
      ]),
    );
    await renderAndDetect('google');

    expect(container.textContent).toContain('本机解析到：gemini');
    expect(container.textContent).toContain('该 client 的默认命令是 agy');
    // A difference is worth naming, not alarming: some providers probe candidates in their own
    // order, so this must not become a warning-coloured claim.
    expect(container.querySelector('.text-conn-red-text')).toBeNull();
  });

  it('says the age is unknown rather than implying it was just checked', async () => {
    apiFetchMock.mockResolvedValue(okResponse([provider()], null));
    await renderAndDetect();

    expect(container.textContent).toContain('报告时间：未知');
    expect(container.textContent).not.toContain('刚刚');
  });

  it('keeps the previous result on screen while re-detecting', async () => {
    apiFetchMock.mockResolvedValueOnce(okResponse([provider()]));
    await renderAndDetect();
    expect(container.textContent).toContain('已安装');

    let release: () => void = () => {};
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(okResponse([provider()]));
        }),
    );
    await clickButton('重新检测');

    const refreshButton = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes('重新检测'));
    expect(refreshButton?.disabled).toBe(true);
    expect(container.textContent).toContain('已安装');
    expect(container.textContent).not.toContain('正在检测本机已安装的 CLI');

    await act(async () => {
      release();
    });
    expect(refreshButton?.disabled).toBe(false);
  });

  it('a failed re-check keeps the previous result and says so', async () => {
    // The refresh route is owner-gated, so a non-owner gets 403 on every click. Blanking the
    // report there would turn a working state into "unavailable" on each attempt.
    apiFetchMock.mockResolvedValueOnce(okResponse([provider()]));
    await renderAndDetect();
    expect(container.textContent).toContain('已安装');

    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    await clickButton('重新检测');

    expect(container.textContent).toContain('重新检测失败');
    expect(container.textContent).toContain('已安装');
    expect(container.textContent).toContain('/usr/local/bin/claude');
    expect(container.textContent).not.toContain('本机 CLI 状态不可用');
  });

  it('never probes or judges a cloud-only member', async () => {
    apiFetchMock.mockResolvedValue(okResponse([provider({ installed: false, status: 'missing' })]));
    await render('openai', { kind: 'cloud', provider: 'openai-chatgpt-pro' });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('云端提供');
    expect(container.textContent).toContain('openai-chatgpt-pro');
    expect(container.textContent).not.toContain('未安装');
    expect(container.textContent).not.toContain('安装命令');
  });

  it('names the ACP command to verify instead of claiming no CLI is needed', async () => {
    apiFetchMock.mockResolvedValue(okResponse([provider()]));
    await render('acp', { kind: 'acp', command: 'my-acp-agent --stdio' });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('my-acp-agent --stdio');
    expect(container.textContent).toContain('CLI 探测不检查自定义命令');
    expect(container.textContent).not.toContain('无需本机 CLI');
    expect(container.textContent).not.toContain('未安装');
  });

  it('says bridged members have no standard local dispatch', async () => {
    apiFetchMock.mockResolvedValue(okResponse([provider()]));
    await render('antigravity', { kind: 'none' });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('不通过标准本地 CLI 派发');
    expect(container.textContent).not.toContain('未安装');
  });
});

describe('resolveMemberCliDispatch', () => {
  const baseForm = {
    clientId: 'anthropic' as const,
    provider: '',
    acpEnabled: false,
    acpCommand: '',
  };

  it('treats the cloud marker as cloud even when the clientId has a local CLI', async () => {
    const { resolveMemberCliDispatch } = await import('../hub-cat-editor.model');
    expect(resolveMemberCliDispatch({ ...baseForm, clientId: 'openai', provider: 'openai-chatgpt-pro' })).toEqual({
      kind: 'cloud',
      provider: 'openai-chatgpt-pro',
    });
  });

  it('prefers cloud over ACP when both markers are present', async () => {
    const { resolveMemberCliDispatch } = await import('../hub-cat-editor.model');
    expect(
      resolveMemberCliDispatch({
        ...baseForm,
        clientId: 'openai',
        provider: 'openai-chatgpt-pro',
        acpEnabled: true,
      }),
    ).toMatchObject({ kind: 'cloud' });
  });

  it('reports the ACP command, flagging an unconfigured one', async () => {
    const { resolveMemberCliDispatch } = await import('../hub-cat-editor.model');
    expect(resolveMemberCliDispatch({ ...baseForm, clientId: 'acp', acpEnabled: true, acpCommand: 'x --y' })).toEqual({
      kind: 'acp',
      command: 'x --y',
    });
    expect(resolveMemberCliDispatch({ ...baseForm, clientId: 'acp', acpEnabled: true })).toEqual({
      kind: 'acp',
      command: '(未配置命令)',
    });
  });

  it('gives a standard verdict only to the five local-CLI clients', async () => {
    const { resolveMemberCliDispatch } = await import('../hub-cat-editor.model');
    for (const clientId of ['anthropic', 'openai', 'google', 'kimi', 'opencode'] as const) {
      expect(resolveMemberCliDispatch({ ...baseForm, clientId })).toEqual({ kind: 'cli' });
    }
    // `a2a` is deliberately outside the editor's ClientId union (see CREATABLE_CLIENT_IDS);
    // an existing a2a member reaches the card through `dispatch`, not through this resolver.
    for (const clientId of ['antigravity', 'catagent', 'acp'] as const) {
      expect(resolveMemberCliDispatch({ ...baseForm, clientId })).toEqual({ kind: 'none' });
    }
  });

  it('ignores a non-marking model provider such as a third-party slug', async () => {
    const { resolveMemberCliDispatch } = await import('../hub-cat-editor.model');
    expect(resolveMemberCliDispatch({ ...baseForm, clientId: 'opencode', provider: 'zhipu' })).toEqual({
      kind: 'cli',
    });
  });
});
