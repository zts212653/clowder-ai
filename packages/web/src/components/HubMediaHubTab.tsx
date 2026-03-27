'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
}

interface ProviderItem {
  id: string;
  displayName: string;
  capabilities: string[];
  requiredFields: ProviderField[];
  envHint?: string;
  bound: boolean;
  healthStatus: string;
  createdAt: number;
}

interface ProvidersResponse {
  enabled: boolean;
  hint?: string;
  providers: ProviderItem[];
}

export function HubMediaHubTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/mediahub/providers');
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((body['error'] as string) ?? '加载失败');
        return;
      }
      setData((await res.json()) as ProvidersResponse);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const handleBind = async (providerId: string) => {
    setFormError(null);
    setBusyId(providerId);
    try {
      const res = await apiFetch(`/api/mediahub/providers/${providerId}/bind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials: formValues }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setFormError((body['error'] as string) ?? '绑定失败');
        return;
      }
      setBindingId(null);
      setFormValues({});
      await fetchProviders();
    } catch {
      setFormError('网络错误');
    } finally {
      setBusyId(null);
    }
  };

  const handleUnbind = async (providerId: string) => {
    setBusyId(providerId);
    try {
      const res = await apiFetch(`/api/mediahub/providers/${providerId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((body['error'] as string) ?? '解绑失败');
        return;
      }
      await fetchProviders();
    } catch {
      setError('网络错误');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <div className="px-6 py-8 text-center text-sm text-gray-400">加载中…</div>;
  }

  if (error) {
    return (
      <div className="px-6 py-8 text-center">
        <p className="text-sm text-red-500">{error}</p>
        <button onClick={fetchProviders} className="mt-2 text-xs text-blue-500 hover:underline">
          重试
        </button>
      </div>
    );
  }

  const providers = data?.providers ?? [];

  return (
    <div className="space-y-4 px-6 py-4">
      <SummaryCard enabled={data?.enabled ?? false} hint={data?.hint} />
      {providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          busy={busyId === p.id}
          binding={bindingId === p.id}
          formValues={bindingId === p.id ? formValues : {}}
          formError={bindingId === p.id ? formError : null}
          onStartBind={() => {
            setBindingId(p.id);
            setFormValues({});
            setFormError(null);
          }}
          onCancelBind={() => {
            setBindingId(null);
            setFormValues({});
            setFormError(null);
          }}
          onFieldChange={(key, val) => setFormValues((prev) => ({ ...prev, [key]: val }))}
          onBind={() => handleBind(p.id)}
          onUnbind={() => handleUnbind(p.id)}
        />
      ))}
    </div>
  );
}

function SummaryCard({ enabled, hint }: { enabled: boolean; hint?: string }) {
  return (
    <div className="rounded-xl bg-gradient-to-r from-violet-50 to-fuchsia-50 p-4">
      <h3 className="text-sm font-semibold text-gray-800">MediaHub — AI 媒体生成</h3>
      <p className="mt-1 text-xs text-gray-500">
        配置 AI 视频/图片生成引擎。绑定账号后，猫猫即可使用对应平台生成媒体内容。
      </p>
      {!enabled && hint && <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">{hint}</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy: 'bg-green-100 text-green-700',
    unchecked: 'bg-gray-100 text-gray-500',
    expired: 'bg-yellow-100 text-yellow-700',
    error: 'bg-red-100 text-red-700',
  };
  const labels: Record<string, string> = {
    healthy: '正常',
    unchecked: '未检测',
    expired: '已过期',
    error: '异常',
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? colors['unchecked']}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

function ProviderCard({
  provider: p,
  busy,
  binding,
  formValues,
  formError,
  onStartBind,
  onCancelBind,
  onFieldChange,
  onBind,
  onUnbind,
}: {
  provider: ProviderItem;
  busy: boolean;
  binding: boolean;
  formValues: Record<string, string>;
  formError: string | null;
  onStartBind: () => void;
  onCancelBind: () => void;
  onFieldChange: (key: string, val: string) => void;
  onBind: () => void;
  onUnbind: () => void;
}) {
  const isEnvOnly = p.requiredFields.length === 0;

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-semibold text-gray-800">{p.displayName}</span>
          <span className="ml-2 text-xs text-gray-400">{p.capabilities.join(' · ')}</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={p.bound ? p.healthStatus : 'unchecked'} />
          {p.bound && (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">已绑定</span>
          )}
        </div>
      </div>

      {isEnvOnly && <p className="mt-2 text-xs text-gray-400">{p.envHint}</p>}

      {!isEnvOnly && !p.bound && !binding && (
        <button
          onClick={onStartBind}
          disabled={busy}
          className="mt-3 rounded-lg bg-violet-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-600 disabled:opacity-50"
        >
          绑定账号
        </button>
      )}

      {!isEnvOnly && p.bound && (
        <button
          onClick={onUnbind}
          disabled={busy}
          className="mt-3 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 disabled:opacity-50"
        >
          {busy ? '解绑中…' : '解绑'}
        </button>
      )}

      {binding && (
        <div className="mt-3 space-y-2 rounded-lg bg-gray-50 p-3">
          {p.requiredFields.map((f) => (
            <div key={f.key}>
              <label className="mb-1 block text-xs font-medium text-gray-600">{f.label}</label>
              <input
                type={f.secret ? 'password' : 'text'}
                value={formValues[f.key] ?? ''}
                onChange={(e) => onFieldChange(f.key, e.target.value)}
                className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-violet-400"
                placeholder={f.label}
              />
            </div>
          ))}
          {formError && <p className="text-xs text-red-500">{formError}</p>}
          <div className="flex gap-2 pt-1">
            <button
              onClick={onBind}
              disabled={busy}
              className="rounded-lg bg-violet-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-600 disabled:opacity-50"
            >
              {busy ? '绑定中…' : '确认绑定'}
            </button>
            <button
              onClick={onCancelBind}
              disabled={busy}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
