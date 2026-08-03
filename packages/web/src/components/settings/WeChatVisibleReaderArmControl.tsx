'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '@/utils/api-client';
import { SettingsBadge } from './primitives/SettingsBadge';

const armEndpoint = '/api/plugins/wechat-visible-reader/arm';

interface ArmStatus {
  enabled: boolean;
  armed: boolean;
  remainingMs: number;
  expiresAt?: string;
}

interface Props {
  pluginEnabled: boolean;
}

function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function WeChatVisibleReaderArmControl({ pluginEnabled }: Props) {
  const [status, setStatus] = useState<ArmStatus | null>(null);
  const [loading, setLoading] = useState(pluginEnabled);
  const [pending, setPending] = useState<'arm' | 'disarm' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!pluginEnabled) return;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(armEndpoint);
      if (!response.ok) throw new Error('status request rejected');
      setStatus((await response.json()) as ArmStatus);
    } catch {
      setError('无法读取授权状态');
    } finally {
      setLoading(false);
    }
  }, [pluginEnabled]);

  useEffect(() => {
    if (!pluginEnabled) {
      setStatus({ enabled: false, armed: false, remainingMs: 0 });
      setLoading(false);
      setError(null);
      return;
    }
    void loadStatus();
  }, [loadStatus, pluginEnabled]);

  useEffect(() => {
    if (!status?.armed) return;
    const timer = window.setInterval(() => {
      setStatus((current) => {
        if (!current?.armed) return current;
        const remainingMs = Math.max(0, current.remainingMs - 1_000);
        return { ...current, armed: remainingMs > 0, remainingMs };
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [status?.armed]);

  const updateAuthorization = async (action: 'arm' | 'disarm') => {
    setPending(action);
    setError(null);
    try {
      const response = await apiFetch(armEndpoint, {
        method: action === 'arm' ? 'POST' : 'DELETE',
        ...(action === 'arm'
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ minutes: 10 }),
            }
          : {}),
      });
      if (!response.ok) throw new Error('authorization request rejected');
      setStatus((await response.json()) as ArmStatus);
    } catch {
      setError(action === 'arm' ? '授权失败，请确认插件已启用' : '撤销失败，请重试');
    } finally {
      setPending(null);
    }
  };

  const armed = Boolean(pluginEnabled && status?.armed && status.remainingMs > 0);

  return (
    <section
      className="rounded-xl border border-cafe bg-cafe-surface-sunken px-3.5 py-3"
      data-testid="wechat-arm-control"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-cafe-text">微信正文短时授权</p>
          <p className="mt-1 text-xs leading-5 text-cafe-muted">
            不会保存截图。识别出的微信文字会进入当前猫的模型上下文和 Clowder AI invocation trace。
          </p>
          <p className="mt-1 text-xs leading-5 text-cafe-muted">
            按联系人读取由你在当前 thread
            逐次授权；执行时会短暂切到微信，可能清除目标会话未读，并在结束后尽力恢复原会话、滚动位置与前台 app。
          </p>
        </div>
        <SettingsBadge tone={armed ? 'emerald' : 'slate'}>{armed ? '已授权' : '未授权'}</SettingsBadge>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2" aria-live="polite">
        <div className="text-xs text-cafe-secondary">
          {!pluginEnabled && '请先启用插件，再进行短时授权。'}
          {pluginEnabled && loading && '正在读取授权状态…'}
          {pluginEnabled && !loading && !error && armed && `已授权 · 剩余 ${formatRemaining(status?.remainingMs ?? 0)}`}
          {pluginEnabled && !loading && !error && !armed && '当前未授权，猫无法触发屏幕捕获。'}
          {error && <span className="font-medium text-conn-red-text">{error}</span>}
        </div>

        <div className="flex items-center gap-2">
          {error && (
            <button type="button" className="console-button-secondary" onClick={() => void loadStatus()}>
              重试
            </button>
          )}
          {pluginEnabled && !loading && !error && !armed && (
            <button
              type="button"
              className="console-button-primary disabled:opacity-50"
              disabled={pending !== null}
              onClick={() => void updateAuthorization('arm')}
            >
              {pending === 'arm' ? '授权中…' : '授权读取 10 分钟'}
            </button>
          )}
          {armed && (
            <button
              type="button"
              className="console-button-secondary disabled:opacity-50"
              disabled={pending !== null}
              onClick={() => void updateAuthorization('disarm')}
            >
              {pending === 'disarm' ? '撤销中…' : '立即撤销'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
