'use client';

import { useState } from 'react';
import { PushServiceConfig } from './PushServiceConfig';

const CARD_SHADOW = 'shadow-[0_12px_30px_rgba(43,33,26,0.08)]';

function describePermission(permission: NotificationPermission | 'unsupported'): string {
  if (permission === 'granted') return '已授权';
  if (permission === 'denied') return '已拒绝';
  if (permission === 'default') return '未选择';
  return '不支持';
}

function describeDelivery(status: 'ok' | 'error' | 'not_attempted', lastError: string | null): string {
  if (status === 'ok') return '正常';
  if (status === 'error') return `失败${lastError ? ` (${lastError})` : ''}`;
  return '未测试';
}

function permissionColor(p: NotificationPermission | 'unsupported'): string {
  if (p === 'granted') return 'text-conn-emerald-text';
  if (p === 'denied') return 'text-conn-red-text';
  return 'text-conn-amber-text';
}

function boolColor(ok: unknown): string {
  return ok ? 'text-conn-emerald-text' : 'text-conn-amber-text';
}

interface PushDiagnosticsSectionProps {
  permission: NotificationPermission | 'unsupported';
  status: {
    capability: { enabled: boolean; vapidPublicKeyConfigured: boolean; pushServiceConfigured: boolean };
    subscription: { count: number; targets: Array<{ endpoint: string; createdAt: number; uaFamily: string }> };
    delivery: {
      lastAttemptAt: number | null;
      lastHttpStatus: number | null;
      lastResult: string | null;
      lastError: string | null;
    };
    errorHints: string[];
  } | null;
  pushConfigured: boolean | undefined | null;
}

export function PushDiagnosticsSection({ permission, status, pushConfigured }: PushDiagnosticsSectionProps) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  return (
    <section>
      <button
        type="button"
        onClick={() => setShowDiagnostics((v) => !v)}
        className="text-xs text-cafe-muted hover:text-cafe-secondary transition-colors"
      >
        {showDiagnostics ? '▾ 收起诊断' : '▸ 诊断信息'}
        {status?.subscription.count ? ` · ${status.subscription.count} 设备` : ''}
      </button>

      {showDiagnostics && (
        <div className={`mt-3 console-list-card rounded-2xl p-4 ${CARD_SHADOW} space-y-4`}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="rounded-lg bg-[var(--console-field-bg)] px-3 py-2">
              <div className="text-cafe-muted">权限</div>
              <div className={`font-semibold ${permissionColor(permission)}`}>{describePermission(permission)}</div>
            </div>
            <div className="rounded-lg bg-[var(--console-field-bg)] px-3 py-2">
              <div className="text-cafe-muted">推送服务</div>
              <div className={`font-semibold ${boolColor(status?.capability.enabled)}`}>
                {status?.capability.enabled ? '已启用' : '未启用'}
              </div>
            </div>
            <div className="rounded-lg bg-[var(--console-field-bg)] px-3 py-2">
              <div className="text-cafe-muted">设备</div>
              <div className={`font-semibold ${boolColor(status?.subscription.count)}`}>
                {status?.subscription.count ?? 0} 台
              </div>
            </div>
            <div className="rounded-lg bg-[var(--console-field-bg)] px-3 py-2">
              <div className="text-cafe-muted">VAPID</div>
              <div className={`font-semibold ${boolColor(status?.capability.vapidPublicKeyConfigured)}`}>
                {status?.capability.vapidPublicKeyConfigured ? '已配置' : '未配置'}
              </div>
            </div>
          </div>

          {status?.subscription.targets && status.subscription.targets.length > 0 && (
            <div>
              <div className="text-xs font-medium text-cafe mb-1.5">已绑定设备</div>
              <ul className="space-y-1 text-xs text-cafe-secondary">
                {status.subscription.targets.slice(0, 5).map((target) => (
                  <li
                    key={`${target.endpoint}-${target.createdAt}`}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="font-medium">{target.uaFamily.toUpperCase()}</span>
                    <span className="truncate text-cafe-muted">{target.endpoint}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {status && (
            <div className="text-xs text-cafe-secondary">
              最近投递：
              {describeDelivery(
                (status.delivery.lastResult as 'ok' | 'error' | 'not_attempted') ?? 'not_attempted',
                status.delivery.lastError ?? null,
              )}
            </div>
          )}

          {pushConfigured && <PushServiceConfig />}

          <p className="text-xs text-cafe-muted">
            iPhone/iPad：PWA Web Push 需先&ldquo;添加到主屏幕&rdquo;再开启通知（Safari 普通标签页不支持）。
          </p>
        </div>
      )}
    </section>
  );
}
