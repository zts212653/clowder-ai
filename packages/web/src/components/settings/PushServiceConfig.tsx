'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ConfigField {
  envName: string;
  label: string;
  sensitive: boolean;
  placeholder: string;
}

const PUSH_FIELDS: ConfigField[] = [
  { envName: 'VAPID_PUBLIC_KEY', label: '推送公钥', sensitive: false, placeholder: '粘贴 VAPID Public Key' },
  { envName: 'VAPID_PRIVATE_KEY', label: '推送私钥', sensitive: true, placeholder: '粘贴 VAPID Private Key' },
  { envName: 'VAPID_SUBJECT', label: '联系信息', sensitive: false, placeholder: 'mailto:admin@example.com' },
];

export function PushServiceConfig({ onSaved }: { onSaved?: () => void }) {
  const [configured, setConfigured] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/push/status');
      if (!res.ok) return;
      const data = await res.json();
      const keysSaved = data.capability?.vapidPublicKeyConfigured || data.capability?.pendingRestart;
      setConfigured({
        VAPID_PUBLIC_KEY: keysSaved ?? false,
        VAPID_PRIVATE_KEY: keysSaved ?? false,
        VAPID_SUBJECT: keysSaved ?? false,
      });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleSave = useCallback(async () => {
    const updates = PUSH_FIELDS.filter((f) => values[f.envName]?.trim()).map((f) => ({
      name: f.envName,
      value: values[f.envName].trim(),
    }));
    if (updates.length === 0) {
      setResult({ type: 'error', message: '请填写至少一个配置项' });
      return;
    }

    setSaving(true);
    setResult(null);
    try {
      const res = await apiFetch('/api/config/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, string>;
        setResult({ type: 'error', message: data.error ?? '保存失败' });
        return;
      }
      setConfigured((prev) => {
        const next = { ...prev };
        for (const u of updates) next[u.name] = true;
        return next;
      });
      setResult({ type: 'success', message: '推送服务配置已保存，需重启后端生效' });
      onSaved?.();
    } catch {
      setResult({ type: 'error', message: '网络错误' });
    } finally {
      setSaving(false);
    }
  }, [values, fetchStatus, onSaved]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setResult(null);
    try {
      const res = await apiFetch('/api/push/generate-vapid', { method: 'POST' });
      if (!res.ok) {
        setResult({ type: 'error', message: '生成失败' });
        return;
      }
      const keys = (await res.json()) as { publicKey: string; privateKey: string };
      setValues((prev) => ({ ...prev, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }));
      setResult({ type: 'success', message: '密钥已生成并回填，请确认后保存' });
    } catch {
      setResult({ type: 'error', message: '网络错误' });
    } finally {
      setGenerating(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      {PUSH_FIELDS.map((field) => (
        <div key={field.envName}>
          <label
            htmlFor={`push-${field.envName}`}
            className="mb-1 flex items-center gap-2 text-xs font-medium text-cafe-secondary"
          >
            {field.label}
            {configured[field.envName] && (
              <span className="rounded-full bg-conn-emerald-bg px-1.5 text-[10px] text-conn-emerald-text">已配置</span>
            )}
          </label>
          <input
            id={`push-${field.envName}`}
            type={field.sensitive ? 'password' : 'text'}
            placeholder={configured[field.envName] ? '已设置（输入新值覆盖）' : field.placeholder}
            value={values[field.envName] ?? ''}
            onChange={(e) => setValues((prev) => ({ ...prev, [field.envName]: e.target.value }))}
            className="console-form-input py-2 text-compact"
            data-testid={`push-field-${field.envName}`}
          />
        </div>
      ))}
      {result && (
        <div
          className={`rounded-lg px-3 py-2 text-xs ${
            result.type === 'success'
              ? 'border border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text'
              : 'border border-conn-red-ring bg-conn-red-bg text-conn-red-text'
          }`}
        >
          {result.message}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={generating}
          className="console-button-secondary text-compact disabled:opacity-50"
        >
          {generating ? '生成中...' : '一键生成密钥'}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="console-button-primary text-compact disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存推送配置'}
        </button>
      </div>
    </div>
  );
}
