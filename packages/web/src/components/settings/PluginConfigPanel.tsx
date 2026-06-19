'use client';

import type { PluginInfo } from '@cat-cafe/shared';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ExternalLinkIcon, StepBadge } from '../HubConfigIcons';
import { ConfigFieldRenderer } from './primitives/ConfigFieldRenderer';

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface Props {
  plugin: PluginInfo;
  onUpdated: () => void;
}

export function PluginConfigPanel({ plugin, onUpdated }: Props) {
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const handleSave = async () => {
    const updates = plugin.config
      .filter((f) => fieldValues[f.envName] !== undefined)
      .map((f) => ({
        name: f.envName,
        value: fieldValues[f.envName] === '' ? null : fieldValues[f.envName]!,
      }));
    if (updates.length === 0) {
      setResult({ type: 'error', msg: '请填写至少一个配置项' });
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      const res = await apiFetch(`/api/plugins/${plugin.id}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setResult({ type: 'error', msg: d.error ?? '保存失败' });
        return;
      }
      setResult({ type: 'success', msg: '配置已保存' });
      setFieldValues({});
      onUpdated();
    } catch {
      setResult({ type: 'error', msg: '网络错误' });
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (action: 'enable' | 'disable') => {
    setToggling(true);
    setResult(null);
    try {
      const res = await apiFetch(`/api/plugins/${plugin.id}/${action}`, { method: 'POST' });
      const data = (await res.json()) as {
        status?: 'success' | 'partial' | 'failed';
        resources?: { type: string; ok: boolean; error?: string }[];
        error?: string;
      };
      if (!res.ok) {
        setResult({ type: 'error', msg: data.error ?? `${action === 'enable' ? '启用' : '停用'}失败` });
      } else if (data.status === 'failed') {
        const failedNames = data.resources?.filter((r) => !r.ok).map((r) => `${r.type}: ${r.error}`) ?? [];
        setResult({ type: 'error', msg: `资源激活失败: ${failedNames.join('; ') || '未知错误'}` });
      } else if (data.status === 'partial') {
        const failedNames = data.resources?.filter((r) => !r.ok).map((r) => `${r.type}: ${r.error}`) ?? [];
        setResult({ type: 'error', msg: `部分资源失败: ${failedNames.join('; ')}` });
        onUpdated();
      } else {
        setResult({ type: 'success', msg: action === 'enable' ? '插件已启用' : '插件已停用' });
        onUpdated();
      }
    } catch {
      setResult({ type: 'error', msg: '网络错误' });
    } finally {
      setToggling(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await apiFetch(`/api/plugins/${plugin.id}/test`, { method: 'POST' });
      const data = (await res.json()) as { ok: boolean; status?: string; error?: string };
      if (data.ok) {
        setResult({ type: 'success', msg: `连接成功 · 状态: ${data.status}` });
      } else {
        setResult({ type: 'error', msg: data.error ?? `连接失败 · 状态: ${data.status ?? 'unknown'}` });
      }
    } catch {
      setResult({ type: 'error', msg: '网络错误' });
    } finally {
      setTesting(false);
    }
  };

  const isEnabled = plugin.status === 'enabled' || plugin.status === 'partial';
  const hasResources = plugin.resources.length > 0;
  const hasSteps = plugin.setupSteps && plugin.setupSteps.length > 0;

  return (
    <div className="space-y-3.5" style={{ paddingInline: '1rem', paddingBottom: '1rem' }}>
      {hasSteps &&
        plugin.setupSteps!.map((step, idx) => (
          <div key={idx} className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <StepBadge num={idx + 1} />
              <span
                className="font-medium"
                style={{ fontSize: 'var(--console-font-compact)', lineHeight: '20px', color: 'var(--cafe-text)' }}
              >
                {step}
              </span>
            </div>
            {idx === 0 && plugin.docsUrl && isSafeUrl(plugin.docsUrl) && (
              <div className="ml-[26px]">
                <a href={plugin.docsUrl} target="_blank" rel="noopener noreferrer" className="console-inline-link">
                  <ExternalLinkIcon />
                  <span>{safeHostname(plugin.docsUrl)} → 查看官方文档</span>
                </a>
              </div>
            )}
          </div>
        ))}

      {!hasSteps && plugin.docsUrl && isSafeUrl(plugin.docsUrl) && (
        <a href={plugin.docsUrl} target="_blank" rel="noopener noreferrer" className="console-inline-link">
          <ExternalLinkIcon />
          <span>{safeHostname(plugin.docsUrl)} → 查看官方文档</span>
        </a>
      )}

      {plugin.config.length > 0 && (
        <div className="space-y-2">
          {hasSteps && (
            <div className="flex items-center gap-1.5">
              <StepBadge num={plugin.setupSteps!.length + 1} />
              <span
                className="font-medium"
                style={{ fontSize: 'var(--console-font-compact)', lineHeight: '20px', color: 'var(--cafe-text)' }}
              >
                填写应用凭证
              </span>
            </div>
          )}
          <div className={hasSteps ? 'ml-[26px] space-y-2.5' : 'space-y-2.5'}>
            {plugin.config.map((f) => (
              <ConfigFieldRenderer
                key={f.envName}
                field={f}
                value={fieldValues[f.envName] ?? ''}
                onChange={(envName, val) => setFieldValues((prev) => ({ ...prev, [envName]: val }))}
                idPrefix="plugin"
              />
            ))}
          </div>
        </div>
      )}

      {plugin.resources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {plugin.resources.map((r, i) => (
            <span
              key={i}
              className={`rounded-[13px] px-2.5 py-0.5 text-label font-medium ${
                r.enabled ? 'bg-conn-emerald-bg text-conn-emerald-text' : 'bg-cafe-surface-sunken text-cafe-muted'
              }`}
            >
              {r.name ?? r.type}
            </span>
          ))}
        </div>
      )}

      {result && (
        <div
          className={`rounded-[16px] px-3 py-2 text-xs ${
            result.type === 'success'
              ? 'border border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text'
              : 'border border-conn-red-ring bg-conn-red-bg text-conn-red-text'
          }`}
        >
          {result.msg}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {hasResources && isEnabled && (
          <button
            type="button"
            onClick={() => void handleToggle('disable')}
            disabled={toggling}
            className="console-button-secondary disabled:opacity-50"
            style={{ fontSize: 'var(--console-font-compact)' }}
            data-testid="plugin-disable-btn"
          >
            {toggling ? '处理中...' : '停用'}
          </button>
        )}
        {hasResources && !isEnabled && (
          <button
            type="button"
            onClick={() => void handleToggle('enable')}
            disabled={toggling}
            className="console-button-secondary disabled:opacity-50"
            style={{ fontSize: 'var(--console-font-compact)' }}
            data-testid="plugin-enable-btn"
          >
            {toggling ? '处理中...' : '启用'}
          </button>
        )}
        {plugin.hasHealthCheck && isEnabled && (
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing}
            className="console-button-secondary disabled:opacity-50"
            style={{ fontSize: 'var(--console-font-compact)' }}
          >
            {testing ? '测试中...' : '测试连接'}
          </button>
        )}
        {plugin.config.length > 0 && (
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="console-button-primary disabled:opacity-50"
            style={{ fontSize: 'var(--console-font-compact)' }}
          >
            {saving ? '保存中...' : '保存配置'}
          </button>
        )}
      </div>
    </div>
  );
}
