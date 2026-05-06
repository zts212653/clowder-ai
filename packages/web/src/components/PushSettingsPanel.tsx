'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePushNotify } from '@/hooks/usePushNotify';
import { useToastStore } from '@/stores/toastStore';
import { SettingsResourceToggleSwitch } from './SettingsResourceCard';
import { PushServiceConfig } from './settings/PushServiceConfig';

const NOTIFY_TYPES = [
  { id: 'reply', label: '猫猫消息', desc: 'AI 回复和主动消息' },
  { id: 'permission', label: '权限请求', desc: '猫猫需要授权时通知' },
  { id: 'mention', label: '@提及', desc: '协作成员提及你时' },
  { id: 'schedule', label: '定时任务', desc: '定时任务执行结果' },
  { id: 'signal', label: '信号更新', desc: '新信号入站提醒' },
] as const;

type NotifyTypeId = (typeof NOTIFY_TYPES)[number]['id'];

const PREFS_KEY = 'clowder-notify-prefs';
const defaultPrefs: Record<NotifyTypeId, boolean> = {
  reply: true,
  permission: true,
  mention: true,
  schedule: true,
  signal: false,
};

function loadPrefs(): Record<NotifyTypeId, boolean> {
  try {
    const r = localStorage.getItem(PREFS_KEY);
    return r ? { ...defaultPrefs, ...JSON.parse(r) } : defaultPrefs;
  } catch {
    return defaultPrefs;
  }
}

export function PushSettingsPanel() {
  const {
    isSupported,
    permission,
    isSubscribed,
    isLoading,
    environmentHint,
    lastError,
    status,
    subscribe,
    unsubscribe,
    sendTest,
  } = usePushNotify();
  const addToast = useToastStore((s) => s.addToast);
  const [isTesting, setIsTesting] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [prefs, setPrefs] = useState(defaultPrefs);
  const [prefsSaved, setPrefsSaved] = useState(false);

  useEffect(() => {
    setPrefs(loadPrefs());
  }, []);

  const togglePref = useCallback((id: NotifyTypeId) => {
    setPrefs((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      setPrefsSaved(true);
      setTimeout(() => setPrefsSaved(false), 1500);
      return next;
    });
  }, []);

  const handleSendTest = async () => {
    if (isTesting) return;
    setIsTesting(true);
    try {
      const result = await sendTest();
      addToast({
        type: result.ok ? 'success' : 'error',
        title: result.ok ? '测试通知已发送' : '测试通知失败',
        message: result.message,
        duration: result.ok ? 3000 : 5000,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const pushConfigured = status?.capability.vapidPublicKeyConfigured && status?.capability.pushServiceConfigured;
  const pendingRestart = status?.capability.pendingRestart;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-cafe">通知渠道</h3>

        <div className="console-list-card rounded-2xl overflow-hidden shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
          <div className="flex items-center gap-4 px-5 py-[18px]">
            <span className="flex h-11 w-11 items-center justify-center rounded-[12px] shrink-0 bg-[var(--push-notify-icon-bg)]">
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.5" className="h-5 w-5">
                <path
                  d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-extrabold text-cafe">浏览器推送</p>
              <p className="text-[11px] text-cafe-muted">
                {!isSupported
                  ? '当前浏览器不支持'
                  : isSubscribed
                    ? '已订阅 · 通知栏接收'
                    : pushConfigured
                      ? '未订阅'
                      : pendingRestart
                        ? '密钥已保存 · 需重启服务生效'
                        : '推送服务未配置'}
              </p>
            </div>
            {isSupported && pushConfigured && (
              <SettingsResourceToggleSwitch
                enabled={isSubscribed}
                busy={isLoading}
                onClick={isSubscribed ? unsubscribe : subscribe}
                title={isSubscribed ? '取消订阅' : '订阅推送'}
              />
            )}
          </div>

          {isSubscribed && (
            <div className="flex items-center gap-2 px-5 py-3">
              <button
                type="button"
                onClick={() => {
                  void handleSendTest();
                }}
                disabled={isTesting}
                className="text-xs text-cafe-secondary hover:text-cafe disabled:opacity-50 transition-colors"
              >
                {isTesting ? '发送中...' : '发送测试通知'}
              </button>
            </div>
          )}

          {isSupported && (
            <div className="px-5 py-3">
              <p className="mb-3 text-[11px] text-cafe-muted leading-relaxed">
                {pushConfigured ? (
                  '推送密钥已配置。如需更新，输入新值后保存即可覆盖。'
                ) : (
                  <>
                    浏览器推送需要配置服务端密钥对来标识推送身份。
                    <br />
                    终端运行{' '}
                    <code className="text-[10px] bg-[var(--console-field-bg)] px-1 py-0.5 rounded">
                      npx web-push generate-vapid-keys
                    </code>{' '}
                    生成后填入下方。
                  </>
                )}
              </p>
              <PushServiceConfig />
            </div>
          )}
        </div>

        <div className="console-list-card rounded-2xl overflow-hidden shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
          <div className="flex items-center gap-4 px-5 py-[18px]">
            <span className="flex h-11 w-11 items-center justify-center rounded-[12px] shrink-0 bg-[var(--push-schedule-icon-bg)]">
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.5" className="h-5 w-5">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4l2 2" strokeLinecap="round" />
              </svg>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-extrabold text-cafe">应用内通知</p>
              <p className="text-[11px] text-cafe-muted">页面内消息提示，始终开启</p>
            </div>
            <span className="shrink-0 rounded-[13px] px-2.5 py-1 text-xs font-semibold bg-conn-emerald-bg text-conn-emerald-text">
              已开启
            </span>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-cafe">通知偏好</h3>
          {prefsSaved && <span className="text-[11px] text-conn-emerald-text">已保存</span>}
        </div>
        <p className="text-xs text-cafe-muted">选择哪些事件触发通知</p>
        <div className="console-list-card rounded-2xl overflow-hidden shadow-[0_12px_30px_rgba(43,33,26,0.08)] divide-y divide-[var(--console-border-soft)]">
          {NOTIFY_TYPES.map((t) => (
            <label
              key={t.id}
              className="flex items-center gap-3 px-5 py-3.5 cursor-pointer hover:bg-[var(--console-hover-bg)] transition-colors"
            >
              <input
                type="checkbox"
                checked={prefs[t.id]}
                onChange={() => togglePref(t.id)}
                className="h-3.5 w-3.5 rounded accent-[var(--color-cafe-accent)]"
              />
              <span className="text-[13px] font-medium text-cafe">{t.label}</span>
              <span className="text-[11px] text-cafe-muted">{t.desc}</span>
            </label>
          ))}
        </div>
      </section>

      {lastError && (
        <div className="rounded-2xl bg-conn-red-bg px-5 py-3 shadow-[0_8px_20px_rgba(43,33,26,0.04)]">
          <p className="text-xs text-conn-red-text">{lastError}</p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowDiagnostics((v) => !v)}
        className="text-xs text-cafe-muted hover:text-cafe-secondary transition-colors"
      >
        {showDiagnostics ? '▾ 收起诊断' : '▸ 诊断信息'}
      </button>

      {showDiagnostics && (
        <div className="console-list-card rounded-2xl p-4 shadow-[0_8px_20px_rgba(43,33,26,0.04)]">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            {[
              {
                label: '权限',
                value: permission === 'granted' ? '已授权' : permission === 'denied' ? '已拒绝' : '未选择',
                color:
                  permission === 'granted'
                    ? 'text-conn-emerald-text'
                    : permission === 'denied'
                      ? 'text-conn-red-text'
                      : 'text-conn-amber-text',
              },
              {
                label: '服务',
                value: status?.capability.enabled ? '正常' : '未启用',
                color: status?.capability.enabled ? 'text-conn-emerald-text' : 'text-conn-amber-text',
              },
              { label: '设备', value: `${status?.subscription.count ?? 0} 台`, color: 'text-cafe' },
              {
                label: 'VAPID',
                value: pendingRestart ? '待重启' : status?.capability.vapidPublicKeyConfigured ? '已配置' : '未配置',
                color: pendingRestart
                  ? 'text-conn-amber-text'
                  : status?.capability.vapidPublicKeyConfigured
                    ? 'text-conn-emerald-text'
                    : 'text-conn-amber-text',
              },
            ].map((d) => (
              <div key={d.label} className="rounded-lg bg-[var(--console-field-bg)] px-3 py-2">
                <div className="text-cafe-muted">{d.label}</div>
                <div className={`font-semibold ${d.color}`}>{d.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {environmentHint && <p className="text-[11px] text-cafe-muted">{environmentHint}</p>}
    </div>
  );
}
