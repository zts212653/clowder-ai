'use client';

import { useCallback, useEffect, useState } from 'react';
import { PushServiceConfig } from '@/components/settings/PushServiceConfig';
import { usePushNotify } from '@/hooks/usePushNotify';
import { useToastStore } from '@/stores/toastStore';
import { SettingsResourceToggleSwitch } from './SettingsResourceCard';
import { PushDiagnosticsSection } from './settings/PushDiagnosticsSection';

const STORAGE_KEY = 'cat-cafe-notify-prefs';

type NotifyTypeId = 'reply' | 'permission' | 'mention' | 'schedule' | 'signal';

const NOTIFY_TYPES: { id: NotifyTypeId; label: string; desc: string; defaultOn: boolean }[] = [
  { id: 'reply', label: '猫猫消息', desc: 'AI 回复和主动消息', defaultOn: true },
  { id: 'permission', label: '权限请求', desc: '猫猫需要授权时通知', defaultOn: true },
  { id: 'mention', label: '@提及', desc: '协作成员提及你时', defaultOn: true },
  { id: 'schedule', label: '定时任务', desc: '定时任务执行结果', defaultOn: true },
  { id: 'signal', label: '信号更新', desc: '新信号入站提醒', defaultOn: false },
];

function loadPrefs(): Record<NotifyTypeId, boolean> {
  const defaults = Object.fromEntries(NOTIFY_TYPES.map((t) => [t.id, t.defaultOn])) as Record<NotifyTypeId, boolean>;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

const REPAIR_HINTS: Record<string, string> = {
  push_vapid_key_missing: '服务端未配置 VAPID 公钥，请先补齐推送密钥环境变量。',
  push_not_configured: 'Push 服务未启用，请确认后端已加载推送服务配置。',
  push_subscription_missing: '当前设备未订阅，点击"开启"并允许系统通知。',
  push_last_delivery_failed: '最近一次系统通知投递失败，请查看网络/代理后重试。',
};

const CARD_SHADOW = 'shadow-[0_12px_30px_rgba(43,33,26,0.08)]';

function BrowserPushCard({
  isSubscribed,
  isLoading,
  pushConfigured,
  isTesting,
  onToggle,
  onSendTest,
}: {
  isSubscribed: boolean;
  isLoading: boolean;
  pushConfigured: boolean | undefined | null;
  isTesting: boolean;
  onToggle: () => void;
  onSendTest: () => void;
}) {
  return (
    <div className={`console-list-card rounded-2xl overflow-hidden ${CARD_SHADOW}`}>
      <div className="flex items-center gap-4 px-5 py-[18px]">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl shrink-0 bg-[var(--cafe-accent,#C65F3D)]">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.5" className="h-5 w-5" aria-hidden="true">
            <path
              d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-base font-extrabold text-cafe">浏览器推送</p>
          <p className="text-xs text-cafe-muted">
            {isSubscribed ? '已订阅 · 通知栏接收' : pushConfigured ? '未订阅' : '推送服务未配置'}
          </p>
        </div>
        {(isSubscribed || pushConfigured) && (
          <SettingsResourceToggleSwitch
            enabled={isSubscribed}
            busy={isLoading}
            onClick={onToggle}
            title={isSubscribed ? '取消订阅' : '订阅推送'}
            disabled={!isSubscribed && !pushConfigured}
          />
        )}
      </div>

      {isSubscribed && (
        <div className="flex items-center gap-2 px-5 py-3 border-t border-[var(--console-border-soft)]">
          <button
            type="button"
            onClick={onSendTest}
            disabled={isTesting || isLoading}
            className="text-xs text-cafe-secondary hover:text-cafe disabled:opacity-50 transition-colors"
          >
            {isTesting ? '发送中...' : '发送测试通知'}
          </button>
        </div>
      )}

      {!pushConfigured && (
        <div className="px-5 py-3 border-t border-[var(--console-border-soft)]">
          <p className="mb-3 text-xs text-cafe-muted leading-relaxed">
            浏览器推送需要配置服务端密钥对来标识推送身份。终端运行{' '}
            <code className="text-[10px] bg-[var(--console-field-bg)] px-1 py-0.5 rounded">
              npx web-push generate-vapid-keys
            </code>{' '}
            生成后填入下方。
          </p>
          <PushServiceConfig />
        </div>
      )}
    </div>
  );
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
  const [lastTestSummary, setLastTestSummary] = useState<{
    attempted: number;
    delivered: number;
    failed: number;
    removed: number;
  } | null>(null);
  const [lastTestMessage, setLastTestMessage] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<NotifyTypeId, boolean>>(loadPrefs);
  const [prefsSaved, setPrefsSaved] = useState(false);

  useEffect(() => {
    setPrefs(loadPrefs());
  }, []);

  const togglePref = useCallback((id: NotifyTypeId) => {
    setPrefs((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setPrefsSaved(true);
    const timer = setTimeout(() => setPrefsSaved(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  const handleSendTest = async () => {
    if (isTesting) return;
    setIsTesting(true);
    try {
      const result = await sendTest();
      setLastTestSummary(result.deliverySummary ?? null);
      setLastTestMessage(result.message);
      const summary = result.deliverySummary
        ? `（成功 ${result.deliverySummary.delivered} / 失败 ${result.deliverySummary.failed} / 清理 ${result.deliverySummary.removed}）`
        : '';
      addToast({
        type: result.ok ? 'success' : 'error',
        title: result.ok ? '系统通知已请求发送' : '系统通知发送失败',
        message: `${result.message}${summary}`,
        duration: result.ok ? 3000 : 5000,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const pushConfigured = status?.capability.vapidPublicKeyConfigured && status?.capability.pushServiceConfigured;

  if (!isSupported) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-cafe">通知渠道</h3>
        <div className="rounded-2xl border border-conn-amber-ring bg-conn-amber-bg px-5 py-4 space-y-2">
          <p className="text-sm text-conn-amber-text font-medium">{environmentHint ?? '当前浏览器不支持推送通知。'}</p>
          <p className="text-xs text-conn-amber-text">
            iPhone 用户请将 Clowder AI 添加到主屏幕后再开启推送（Safari 普通标签页不支持 Web Push）。
          </p>
        </div>
      </div>
    );
  }

  const mappedHints = (status?.errorHints ?? [])
    .map((hint) => REPAIR_HINTS[hint] ?? null)
    .filter((hint): hint is string => Boolean(hint));

  return (
    <div className="space-y-6">
      {/* Section 1: Channels */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-cafe">通知渠道</h3>

        <BrowserPushCard
          isSubscribed={isSubscribed}
          isLoading={isLoading}
          pushConfigured={pushConfigured}
          isTesting={isTesting}
          onToggle={isSubscribed ? unsubscribe : subscribe}
          onSendTest={() => {
            void handleSendTest();
          }}
        />

        <div className={`console-list-card rounded-2xl overflow-hidden ${CARD_SHADOW}`}>
          <div className="flex items-center gap-4 px-5 py-[18px]">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl shrink-0 bg-conn-emerald-text">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth="1.5"
                className="h-5 w-5"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4l2 2" strokeLinecap="round" />
              </svg>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-base font-extrabold text-cafe">应用内通知</p>
              <p className="text-xs text-cafe-muted">页面内消息提示，始终开启</p>
            </div>
            <span className="shrink-0 rounded-xl px-2.5 py-1 text-xs font-semibold bg-conn-emerald-bg text-conn-emerald-text">
              已开启
            </span>
          </div>
        </div>
      </section>

      {/* Section 2: Preferences */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-cafe">通知偏好</h3>
          {prefsSaved && <span className="text-xs text-conn-emerald-text">已保存</span>}
        </div>
        <p className="text-xs text-cafe-muted">选择哪些事件触发通知</p>
        <div
          className={`console-list-card rounded-2xl overflow-hidden ${CARD_SHADOW} divide-y divide-[var(--console-border-soft)]`}
        >
          {NOTIFY_TYPES.map((type) => (
            <label
              key={type.id}
              className="flex items-center gap-3 px-5 py-3.5 cursor-pointer hover:bg-[var(--console-hover-bg)] transition-colors"
            >
              <input
                type="checkbox"
                checked={prefs[type.id]}
                onChange={() => togglePref(type.id)}
                className="h-3.5 w-3.5 rounded accent-[var(--color-cafe-accent)]"
              />
              <span className="text-sm font-medium text-cafe">{type.label}</span>
              <span className="text-xs text-cafe-muted">{type.desc}</span>
            </label>
          ))}
        </div>
      </section>

      {/* Errors and hints */}
      {environmentHint && (
        <div className="rounded-2xl bg-conn-amber-bg border border-conn-amber-ring px-5 py-3">
          <p className="text-xs text-conn-amber-text">{environmentHint}</p>
        </div>
      )}
      {lastError && (
        <div className="rounded-2xl bg-conn-red-bg border border-conn-red-ring px-5 py-3">
          <p className="text-xs text-conn-red-text">{lastError}</p>
        </div>
      )}
      {mappedHints.length > 0 && (
        <div className="rounded-2xl border border-conn-amber-ring bg-conn-amber-bg px-5 py-3">
          <div className="text-sm font-medium text-conn-amber-text">修复建议</div>
          <ul className="mt-2 space-y-1 text-xs text-conn-amber-text list-disc pl-4">
            {mappedHints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        </div>
      )}

      {lastTestSummary && (
        <div className={`console-list-card rounded-2xl p-4 ${CARD_SHADOW} text-xs space-y-1`}>
          <div className="text-sm font-medium text-cafe">最近测试</div>
          {lastTestMessage && <p className="text-cafe-secondary">{lastTestMessage}</p>}
          <p className="text-cafe-secondary">
            尝试 {lastTestSummary.attempted} · 成功 {lastTestSummary.delivered} · 失败 {lastTestSummary.failed} · 清理{' '}
            {lastTestSummary.removed}
          </p>
        </div>
      )}

      {/* Section 3: Diagnostics (collapsed) */}
      <PushDiagnosticsSection permission={permission} status={status} pushConfigured={pushConfigured} />
    </div>
  );
}
