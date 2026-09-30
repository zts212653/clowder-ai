'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { settingsResourceCardClass } from '../SettingsResourceCard';
import { SettingsBadge } from './primitives/SettingsBadge';
import { SettingsPrimaryButton } from './primitives/SettingsPrimaryButton';
import { SettingsSecondaryButton } from './primitives/SettingsSecondaryButton';
import { SettingsText } from './primitives/SettingsText';

/**
 * F247 Workspace Agent Settings card (contract #7): trigger id, authorize /
 * re-auth, disable, and one real test trigger. The access token is
 * write-only — the server only ever returns a `tokenConfigured` bit.
 */
interface WorkspaceAgentProjection {
  enabled: boolean;
  triggerId: string | null;
  workspaceId: string | null;
  tokenConfigured: boolean;
  source: 'settings' | 'env' | null;
  invalidConfig?: { reason: 'corrupt_file' | 'unreadable_file' | 'schema_invalid' | 'env_invalid' };
}

interface TestResult {
  ok: boolean;
  conversationUrl?: string;
  code?: string;
  message?: string;
}

const INVALID_REASONS: Record<string, string> = {
  corrupt_file: '配置文件损坏（不是合法 JSON）',
  unreadable_file: '配置文件当前无法读取（权限或路径异常）',
  schema_invalid: '配置内容不合规（例如 workspaceId 含非法字符或缺字段）',
  env_invalid: '环境变量引导的配置不合规（workspaceId / triggerId 含非法字符）',
};

function badgeFor(state: WorkspaceAgentProjection) {
  if (state.invalidConfig) return { label: '需修复', tone: 'red' as const };
  if (state.enabled) return { label: '已启用', tone: 'emerald' as const };
  return { label: '未启用', tone: 'slate' as const };
}

export function WorkspaceAgentPluginPanel() {
  const [state, setState] = useState<WorkspaceAgentProjection | null>(null);
  const [triggerId, setTriggerId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/plugins/workspace-agent');
      if (!response.ok) throw new Error(`Workspace Agent 状态读取失败 (${response.status})`);
      const projection = (await response.json()) as WorkspaceAgentProjection;
      setState(projection);
      setTriggerId(projection.triggerId ?? '');
      setWorkspaceId(projection.workspaceId ?? '');
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workspace Agent 状态读取失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // astra round-6 N1: the initial reveal must wait for the card to actually
  // mount — the async GET has to land first, so this effect re-runs on state.
  useEffect(() => {
    if (!state) return;
    const reveal = () => {
      if (window.location.hash === '#workspace-agent') {
        document.getElementById('workspace-agent')?.scrollIntoView?.({ block: 'center' });
      }
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, [state]);

  const save = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      setError(null);
      setTestResult(null);
      try {
        const body: Record<string, unknown> = { enabled };
        if (triggerId.trim()) body.triggerId = triggerId.trim();
        if (workspaceId.trim()) body.workspaceId = workspaceId.trim();
        if (token) body.token = token;
        const response = await apiFetch('/api/plugins/workspace-agent/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = (await response.json().catch(() => ({}))) as WorkspaceAgentProjection & {
          error?: string;
          detail?: string;
        };
        if (!response.ok) throw new Error(result.detail ?? result.error ?? `保存失败 (${response.status})`);
        setState(result);
        setTriggerId(result.triggerId ?? '');
        setWorkspaceId(result.workspaceId ?? '');
        setToken('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '保存失败');
      } finally {
        setBusy(false);
      }
    },
    [triggerId, workspaceId, token],
  );

  const disable = useCallback(async () => {
    if (!window.confirm('确认停用 Workspace Agent 通道？已保存的 token 会保留，重新启用无需重新粘贴。')) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const response = await apiFetch('/api/plugins/workspace-agent', { method: 'DELETE' });
      const result = (await response.json().catch(() => ({}))) as WorkspaceAgentProjection & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `停用失败 (${response.status})`);
      setState(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '停用失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const runTest = useCallback(async () => {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const response = await apiFetch('/api/plugins/workspace-agent/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const result = (await response.json().catch(() => ({}))) as TestResult & { error?: string };
      setTestResult(response.ok ? result : { ok: false, code: result.code, message: result.error ?? result.message });
    } catch (cause) {
      setTestResult({ ok: false, message: cause instanceof Error ? cause.message : '测试请求失败' });
    } finally {
      setBusy(false);
    }
  }, []);

  if (!state && !error) return <SettingsText tone="muted">正在读取 Workspace Agent 状态…</SettingsText>;

  const badge = state ? badgeFor(state) : null;

  return (
    <section className="contents" data-testid="workspace-agent-plugin-panel">
      {error && <div className="rounded-md bg-conn-red-bg px-3 py-2 text-sm text-conn-red-text">{error}</div>}
      {state && (
        <div id="workspace-agent" className={settingsResourceCardClass}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <SettingsText as="h3" className="truncate">
                  Workspace Agent（ChatGPT 团队版通道）
                </SettingsText>
                {badge && <SettingsBadge tone={badge.tone}>{badge.label}</SettingsBadge>}
              </div>
              <SettingsText as="p" tone="muted" className="mt-1">
                官方 Trigger API 出站通道：本地 @gpt-pro 经 trigger 投递，云端经 Remote MCP 回写。个人版 Personal Chrome
                通道不受影响。
              </SettingsText>
            </div>
          </div>

          {state.invalidConfig && (
            <div
              className="mt-2 rounded-md bg-conn-red-bg px-3 py-2 text-sm text-conn-red-text"
              data-testid="workspace-agent-invalid"
            >
              配置不可用：{INVALID_REASONS[state.invalidConfig.reason] ?? state.invalidConfig.reason}
              。恢复路径：在下方完整保存一份有效配置（或重启服务后重试读取）；仅修复文件权限不会让当前实例自动重读。
            </div>
          )}

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-conn-muted">Trigger ID（agtch_…）</span>
              <input
                className="rounded-md border border-conn-border bg-transparent px-2 py-1"
                value={triggerId}
                onChange={(event) => setTriggerId(event.target.value)}
                placeholder="agtch_…"
                data-testid="workspace-agent-trigger-id"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-conn-muted">Workspace ID</span>
              <input
                className="rounded-md border border-conn-border bg-transparent px-2 py-1"
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                placeholder="不含冒号 / 空白 / 控制字符"
                data-testid="workspace-agent-workspace-id"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="text-conn-muted">
                访问 token
                {state.tokenConfigured
                  ? '（服务端已保管；留空则沿用，不会回显）'
                  : '（Admin > Access tokens 创建，Workspace Agents scope）'}
              </span>
              <input
                className="rounded-md border border-conn-border bg-transparent px-2 py-1"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={state.tokenConfigured ? '••••••••（已保管）' : '粘贴 token'}
                data-testid="workspace-agent-token"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <SettingsPrimaryButton
              disabled={busy || !triggerId.trim() || !workspaceId.trim() || (!token && !state.tokenConfigured)}
              onClick={() => void save(true)}
            >
              {state.enabled ? '保存并启用' : '授权并启用'}
            </SettingsPrimaryButton>
            {state.enabled && (
              <>
                <SettingsSecondaryButton disabled={busy} onClick={() => void runTest()}>
                  发送测试触发
                </SettingsSecondaryButton>
                <SettingsSecondaryButton disabled={busy} onClick={() => void disable()}>
                  停用
                </SettingsSecondaryButton>
              </>
            )}
          </div>

          {testResult && (
            <div
              className={`mt-2 rounded-md px-3 py-2 text-sm ${
                testResult.ok ? 'bg-conn-emerald-bg text-conn-emerald-text' : 'bg-conn-red-bg text-conn-red-text'
              }`}
              data-testid="workspace-agent-test-result"
            >
              {testResult.ok
                ? `测试触发已接受：${testResult.conversationUrl ?? ''}（该会话仅用于自检）`
                : `测试失败：${testResult.code ?? 'UNKNOWN'}${testResult.message ? ` — ${testResult.message}` : ''}`}
            </div>
          )}

          {state.source && (
            <SettingsText as="p" tone="muted" className="mt-2">
              当前配置来源：
              {state.source === 'env'
                ? '环境变量引导（在设置里保存一份后会转为设置托管）'
                : '设置文件（.cat-cafe/workspace-agent.json，0600）'}
            </SettingsText>
          )}
        </div>
      )}
    </section>
  );
}
