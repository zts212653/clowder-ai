'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PushStatusPayload } from '@/hooks/usePushNotify';
import { apiFetch } from '@/utils/api-client';
import { formInputClass } from '../mcp-form-helpers';
import {
  SettingsCard,
  SettingsPrimaryButton,
  SettingsSecondaryButton,
  SettingsStatusStrip,
  SettingsText,
} from './primitives';

const REDACTED_PLACEHOLDER = '••••••';

type PushConfigField = 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT';

interface PushConfigFormState {
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

const EMPTY_FORM: PushConfigFormState = {
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
  VAPID_SUBJECT: '',
};

function asStatusPayload(value: unknown): PushStatusPayload | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { capability?: unknown; subscription?: unknown; delivery?: unknown; errorHints?: unknown };
  if (!candidate.capability || typeof candidate.capability !== 'object') return null;
  return value as PushStatusPayload;
}

function friendlyError(message: string, fallback: string): string {
  if (message.includes('configured owner')) {
    return '当前会话用户不是配置 owner，不能修改推送密钥。';
  }
  return message.trim() || fallback;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: unknown };
    if (typeof payload.error === 'string') return friendlyError(payload.error, fallback);
  } catch {
    // ignore non-json body
  }
  return fallback;
}

export function PushServiceConfig({ embedded = false }: { embedded?: boolean } = {}) {
  const [form, setForm] = useState<PushConfigFormState>(EMPTY_FORM);
  const [status, setStatus] = useState<PushStatusPayload | null>(null);
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/push/status');
      if (!res.ok) return;
      const payload = asStatusPayload(await res.json());
      if (payload) setStatus(payload);
    } catch {
      // Push config is additive; the existing diagnostics panel still owns connection errors.
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const updateField = (field: PushConfigField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleGenerate = async () => {
    if (busy) return;
    setBusy('generate');
    setMessage(null);
    try {
      const res = await apiFetch('/api/push/generate-vapid', { method: 'POST' });
      if (!res.ok) {
        setMessage({ tone: 'error', text: await readError(res, `生成失败（HTTP ${res.status}）`) });
        return;
      }
      const payload = (await res.json()) as { publicKey?: unknown; privateKey?: unknown };
      if (typeof payload.publicKey !== 'string' || typeof payload.privateKey !== 'string') {
        setMessage({ tone: 'error', text: '生成接口返回格式不正确。' });
        return;
      }
      const publicKey = payload.publicKey;
      const privateKey = payload.privateKey;
      setForm((current) => ({
        ...current,
        VAPID_PUBLIC_KEY: publicKey,
        VAPID_PRIVATE_KEY: privateKey,
      }));
      setMessage({ tone: 'info', text: '已生成一组新密钥，请保存后生效。' });
    } catch {
      setMessage({ tone: 'error', text: '生成失败，请检查 API 连接后重试。' });
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    if (busy) return;
    setBusy('save');
    setMessage(null);
    try {
      const updates = (Object.entries(form) as Array<[PushConfigField, string]>)
        .map(([name, value]) => ({ name, value: value.trim() }))
        .filter((update) => update.value.length > 0);
      if (updates.length === 0) {
        setMessage({ tone: 'info', text: '没有需要保存的推送配置。' });
        return;
      }
      if (updates.some((update) => update.value.includes(REDACTED_PLACEHOLDER))) {
        setMessage({ tone: 'error', text: '不能保存已脱敏占位符，请留空保持原值或输入新值。' });
        return;
      }
      const res = await apiFetch('/api/config/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) {
        setMessage({ tone: 'error', text: await readError(res, `保存失败（HTTP ${res.status}）`) });
        return;
      }
      setForm((current) => ({ ...current, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' }));
      setMessage({ tone: 'success', text: '推送配置已保存，密钥字段已清空。' });
      await refreshStatus();
    } catch {
      setMessage({ tone: 'error', text: '保存失败，请检查 API 连接后重试。' });
    } finally {
      setBusy(null);
    }
  };

  const messageTone = message?.tone === 'success' ? 'success' : message?.tone === 'error' ? 'error' : 'info';

  const content = (
    <>
      <SettingsText as="p" tone="secondary">
        <SettingsText as="span" tone="default" className="font-medium">
          VAPID 推送密钥
        </SettingsText>{' '}
        — 保存后写入运行时 .env；密钥字段留空会保留现有值。
      </SettingsText>

      <div className="grid gap-2">
        <label className="flex items-center gap-3">
          <SettingsText as="span" tone="secondary" className="w-20 shrink-0 font-medium">
            推送公钥
          </SettingsText>
          <input
            name="VAPID_PUBLIC_KEY"
            value={form.VAPID_PUBLIC_KEY}
            onChange={(event) => updateField('VAPID_PUBLIC_KEY', event.target.value)}
            placeholder={status?.capability.vapidPublicKeyConfigured ? '已配置，留空保持不变' : 'VAPID public key'}
            className={`flex-1 ${formInputClass}`}
          />
        </label>
        <label className="flex items-center gap-3">
          <SettingsText as="span" tone="secondary" className="w-20 shrink-0 font-medium">
            推送私钥
          </SettingsText>
          <input
            name="VAPID_PRIVATE_KEY"
            type="password"
            value={form.VAPID_PRIVATE_KEY}
            onChange={(event) => updateField('VAPID_PRIVATE_KEY', event.target.value)}
            placeholder={status?.capability.pushServiceConfigured ? '已配置，留空保持不变' : 'VAPID private key'}
            className={`flex-1 ${formInputClass}`}
          />
        </label>
        <label className="flex items-center gap-3">
          <SettingsText as="span" tone="secondary" className="w-20 shrink-0 font-medium">
            联系信息
          </SettingsText>
          <input
            name="VAPID_SUBJECT"
            value={form.VAPID_SUBJECT}
            onChange={(event) => updateField('VAPID_SUBJECT', event.target.value)}
            placeholder="mailto:admin@example.com"
            className={`flex-1 ${formInputClass}`}
          />
        </label>
      </div>

      {message && (
        <SettingsStatusStrip tone={messageTone} size="xs" bordered>
          {message.text}
        </SettingsStatusStrip>
      )}

      <div className="flex justify-end gap-2">
        <SettingsSecondaryButton
          onClick={() => {
            void handleGenerate();
          }}
          disabled={busy !== null}
        >
          {busy === 'generate' ? '生成中...' : '生成 VAPID 密钥'}
        </SettingsSecondaryButton>
        <SettingsPrimaryButton
          onClick={() => {
            void handleSave();
          }}
          disabled={busy !== null}
        >
          {busy === 'save' ? '保存中...' : '保存推送配置'}
        </SettingsPrimaryButton>
      </div>
    </>
  );

  if (embedded) {
    return <div className="space-y-4">{content}</div>;
  }

  return <SettingsCard className="space-y-4">{content}</SettingsCard>;
}
