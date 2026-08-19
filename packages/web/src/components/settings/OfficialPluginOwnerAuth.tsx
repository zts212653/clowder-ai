import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { QrImagePanel } from './primitives/ActionRendererParts';
import { SettingsPrimaryButton } from './primitives/SettingsPrimaryButton';
import { SettingsText } from './primitives/SettingsText';

export type OwnerAuthStatus = 'checking' | 'not_connected' | 'waiting' | 'connected' | 'expired' | 'failed';

export interface OwnerAuthState {
  status: OwnerAuthStatus;
  verificationUrl?: string;
  userCode?: string;
  qrDataUrl?: string;
  error?: string;
}

const AUTH_REFRESH_MS = 2_500;

export function ownerAuthGuidance(auth: OwnerAuthState | null): string | undefined {
  switch (auth?.status) {
    case 'checking':
      return '正在检查飞书账号连接状态…';
    case 'not_connected':
      return '先连接飞书账号；授权完成后才能启用会议纪要同步。';
    case 'waiting':
      return '请用飞书扫码，或打开下方链接完成授权。';
    case 'expired':
      return '认证链接已过期，请重新连接飞书。';
    case 'failed':
      return auth.error ?? '飞书认证未完成，请重试。';
    default:
      return undefined;
  }
}

function actionLabel(auth: OwnerAuthState | null, busy: boolean): string {
  if (auth?.status === 'waiting') return '等待授权…';
  if (busy) return '连接中…';
  if (auth?.status === 'expired' || auth?.status === 'failed') return '重新连接';
  return '连接飞书';
}

export function useOfficialPluginOwnerAuth({
  available,
  instanceId,
  onWaiting,
}: {
  available: boolean;
  instanceId?: string;
  onWaiting: () => void;
}) {
  const authInstanceId = available ? instanceId : undefined;
  const [auth, setAuth] = useState<OwnerAuthState | null>(available ? { status: 'checking' } : null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    if (!authInstanceId) return;
    try {
      const response = await apiFetch(`/api/plugins/official/${authInstanceId}/auth`);
      const body = (await response.json().catch(() => ({}))) as OwnerAuthState & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `飞书认证状态读取失败 (${response.status})`);
      setAuth(body);
      if (body.status === 'waiting') onWaiting();
    } catch (cause) {
      setAuth({ status: 'failed', error: cause instanceof Error ? cause.message : '飞书认证状态读取失败' });
    }
  }, [authInstanceId, onWaiting]);

  useEffect(() => {
    if (!authInstanceId) {
      setAuth(null);
      return;
    }
    setAuth({ status: 'checking' });
    void read();
  }, [authInstanceId, read]);

  useEffect(() => {
    if (auth?.status !== 'waiting') return;
    const refresh = window.setInterval(() => void read(), AUTH_REFRESH_MS);
    return () => window.clearInterval(refresh);
  }, [auth?.status, read]);

  const start = useCallback(async () => {
    if (!authInstanceId) return;
    setBusy(true);
    onWaiting();
    try {
      const response = await apiFetch(`/api/plugins/official/${authInstanceId}/auth/start`, { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as OwnerAuthState & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `飞书认证发起失败 (${response.status})`);
      setAuth(body);
    } catch (cause) {
      setAuth({ status: 'failed', error: cause instanceof Error ? cause.message : '飞书认证发起失败' });
    } finally {
      setBusy(false);
    }
  }, [authInstanceId, onWaiting]);

  return {
    auth,
    busy,
    connected: authInstanceId === undefined || auth?.status === 'connected',
    start,
  };
}

export function OfficialPluginOwnerAuthAction({
  auth,
  busy,
  pluginBusy,
  onStart,
}: {
  auth: OwnerAuthState | null;
  busy: boolean;
  pluginBusy: boolean;
  onStart: () => void;
}) {
  return (
    <SettingsPrimaryButton
      disabled={pluginBusy || busy || auth?.status === 'checking' || auth?.status === 'waiting'}
      onClick={onStart}
    >
      {actionLabel(auth, busy)}
    </SettingsPrimaryButton>
  );
}

export function OfficialPluginOwnerAuthDetails({ auth }: { auth: OwnerAuthState | null }) {
  if (auth?.status === 'connected') {
    return (
      <SettingsText as="p" tone="green" className="mt-1">
        飞书账号已连接
      </SettingsText>
    );
  }
  if (auth?.status !== 'waiting' || !auth.qrDataUrl || !auth.verificationUrl) return null;
  return (
    <div className="mt-3 space-y-3">
      <a
        href={auth.verificationUrl}
        target="_blank"
        rel="noreferrer"
        className="block break-all text-sm text-conn-blue-text underline underline-offset-2"
        data-testid="feishu-meeting-intake-auth-link"
      >
        在浏览器中打开飞书认证
      </a>
      {auth.userCode && (
        <SettingsText as="p" tone="secondary">
          验证码：<span className="font-mono font-semibold text-cafe-primary">{auth.userCode}</span>
        </SettingsText>
      )}
      <QrImagePanel connectorId="feishu-meeting-intake" url={auth.qrDataUrl} statusLabel="等待飞书授权…" showSpinner />
    </div>
  );
}
