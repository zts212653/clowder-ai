'use client';

/**
 * Push Notification Settings Panel
 * 推送通知设置 — CatCafeHub "通知" tab
 */

import { useState } from 'react';
import { usePushNotify } from '@/hooks/usePushNotify';
import { useToastStore } from '@/stores/toastStore';

const REPAIR_HINTS: Record<string, string> = {
  push_vapid_key_missing: '服务端未配置 VAPID 公钥，请先补齐推送密钥环境变量。',
  push_not_configured: 'Push 服务未启用，请确认后端已加载推送服务配置。',
  push_subscription_missing: '当前设备未订阅，点击“开启”并允许系统通知。',
  push_last_delivery_failed: '最近一次系统通知投递失败，请查看网络/代理后重试。',
};

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

  if (!isSupported) {
    return (
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-gray-800">推送通知</h3>
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 space-y-2">
          <p className="text-sm text-amber-900 font-medium">{environmentHint ?? '当前浏览器不支持推送通知。'}</p>
          <p className="text-xs text-amber-700">
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
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-gray-800">推送通知</h3>
        <p className="text-sm text-gray-600">
          开启后，猫猫回复、权限请求等会推送到系统通知栏（即使不在 Clowder AI 页面）。
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
        <div className="text-sm font-medium text-gray-800">通知能力矩阵</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <div className="text-gray-500">浏览器支持</div>
            <div className="font-semibold text-emerald-700">已支持</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <div className="text-gray-500">权限状态</div>
            <div
              className={`font-semibold ${permission === 'granted' ? 'text-emerald-700' : permission === 'denied' ? 'text-rose-700' : 'text-amber-700'}`}
            >
              {describePermission(permission)}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <div className="text-gray-500">推送服务</div>
            <div className={`font-semibold ${status?.capability.enabled ? 'text-emerald-700' : 'text-amber-700'}`}>
              {status?.capability.enabled ? '已启用' : '未启用'}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <div className="text-gray-500">设备订阅</div>
            <div className={`font-semibold ${status?.subscription.count ? 'text-emerald-700' : 'text-amber-700'}`}>
              {status?.subscription.count ?? 0} 台
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <div className="text-gray-500">最近投递</div>
            <div
              className={`font-semibold ${status?.delivery.lastResult === 'ok' ? 'text-emerald-700' : status?.delivery.lastResult === 'error' ? 'text-rose-700' : 'text-gray-700'}`}
            >
              {describeDelivery(status?.delivery.lastResult ?? 'not_attempted', status?.delivery.lastError ?? null)}
            </div>
          </div>
        </div>
        {status && (
          <p className="text-xs text-gray-500">
            服务状态：{status.capability.enabled ? '已启用' : '未启用'}
            {' · '}VAPID：{status.capability.vapidPublicKeyConfigured ? '已配置' : '未配置'}
            {' · '}PushService：{status.capability.pushServiceConfigured ? '可用' : '不可用'}
            {' · '}设备订阅：{status.subscription.count} 台{' · '}最近投递：
            {status.delivery.lastResult === 'ok' ? '成功' : status.delivery.lastResult === 'error' ? '失败' : '未测试'}
          </p>
        )}
      </div>

      {mappedHints.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-sm font-medium text-amber-900">修复建议</div>
          <ul className="mt-2 space-y-1 text-xs text-amber-800 list-disc pl-4">
            {mappedHints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        </div>
      )}

      {status?.subscription.targets && status.subscription.targets.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
          <div className="text-sm font-medium text-gray-800">已绑定设备</div>
          <ul className="mt-2 space-y-1 text-xs text-gray-600">
            {status.subscription.targets.slice(0, 3).map((target) => (
              <li key={`${target.endpoint}-${target.createdAt}`} className="flex items-center justify-between gap-2">
                <span>{target.uaFamily.toUpperCase()}</span>
                <span className="truncate">{target.endpoint}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {lastTestSummary && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700 space-y-1">
          <div className="text-sm font-medium text-slate-900">最近测试</div>
          {lastTestMessage && <p>{lastTestMessage}</p>}
          <p>
            尝试 {lastTestSummary.attempted} · 成功 {lastTestSummary.delivered} · 失败 {lastTestSummary.failed} · 清理{' '}
            {lastTestSummary.removed}
          </p>
        </div>
      )}

      {environmentHint && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <p className="text-xs text-amber-700">{environmentHint}</p>
        </div>
      )}
      {lastError && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3">
          <p className="text-xs text-rose-700">{lastError}</p>
        </div>
      )}

      <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-gray-700">{isSubscribed ? '已开启推送' : '推送已关闭'}</p>
          <p className="text-xs text-gray-500">{isSubscribed ? '猫猫消息会推送到通知栏' : '点击开启接收猫猫推送'}</p>
        </div>
        <button
          onClick={isSubscribed ? unsubscribe : subscribe}
          disabled={isLoading}
          className={`px-4 py-1.5 text-sm rounded-lg font-medium transition-colors ${
            isSubscribed ? 'bg-gray-200 text-gray-700 hover:bg-gray-300' : 'bg-blue-600 text-white hover:bg-blue-700'
          } disabled:opacity-50`}
        >
          {isLoading ? '处理中...' : isSubscribed ? '关闭' : '开启'}
        </button>
      </div>

      {isSubscribed && (
        <button
          type="button"
          onClick={() => {
            void handleSendTest();
          }}
          disabled={isTesting || isLoading}
          className="text-xs text-blue-600 hover:text-blue-800 underline"
        >
          {isTesting ? '发送中...' : '发送测试通知'}
        </button>
      )}
      <p className="text-[11px] text-gray-500">iPhone 路线（Phase 3）：PWA Web Push。请先“添加到主屏幕”再开启通知。</p>
    </div>
  );
}
