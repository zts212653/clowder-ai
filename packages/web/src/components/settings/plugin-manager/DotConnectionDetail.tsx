'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsSecondaryButton } from '../primitives/SettingsSecondaryButton';
import { SettingsText } from '../primitives/SettingsText';
import { dotActivationFeedback } from './dot-activation-feedback';

interface DotStatus {
  attemptId?: string | null;
  installed: boolean;
  endpointUrl: string | null;
  paired: boolean;
  subscription: 'active' | 'expired' | 'absent';
  replyAt: number | null;
  imageAt: number | null;
  revoked: boolean;
  ownerUserId?: string | null;
  instructions?: string;
}
interface DotTest {
  eventId: string;
  threadId?: string;
  receivedAt?: number | null;
  readAt?: number | null;
  replyMessageId?: string | null;
}

export function DotConnectionDetail({
  installed,
  activationRequest = 0,
  activationAllowed = false,
  onStateChanged,
  secondaryAction = false,
}: {
  installed: boolean;
  activationRequest?: number;
  activationAllowed?: boolean;
  onStateChanged?: () => void | Promise<void>;
  secondaryAction?: boolean;
}) {
  const [status, setStatus] = useState<DotStatus | null>(null);
  const [setup, setSetup] = useState<DotStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [tests, setTests] = useState<DotTest[]>([]);
  const observedAttempt = useRef<string | null | undefined>(undefined);
  const activationNotice = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/plugins/chatgpt-dot/connection');
      if (!response.ok) throw new Error('暂时无法读取 dot 连接状态，请重试。');
      const result = (await response.json()) as DotStatus;
      if (!result.paired || observedAttempt.current !== result.attemptId) setTests([]);
      observedAttempt.current = result.attemptId;
      setStatus(result);
      if (result.paired) {
        const tested = await apiFetch('/api/plugins/chatgpt-dot/test');
        if (!tested.ok) throw new Error('暂时无法核对往返结果；保留最后确认状态。');
        setTests(((await tested.json()) as { tests: DotTest[] }).tests);
      }
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '连接状态读取失败');
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (activationRequest > 0) void load();
  }, [activationRequest, load]);
  useEffect(() => {
    if (activationRequest <= 0 || activationAllowed) return;
    activationNotice.current?.scrollIntoView?.({ block: 'nearest' });
    activationNotice.current?.focus({ preventScroll: true });
  }, [activationRequest, activationAllowed]);
  const testConnection = async () => {
    setBusy(true);
    try {
      const response = await apiFetch('/api/plugins/chatgpt-dot/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error('往返测试暂时无法发起，请核对订阅后重试。');
      await load();
      await onStateChanged?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '测试失败');
    } finally {
      setBusy(false);
    }
  };

  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch('/api/plugins/chatgpt-dot/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reconnect: status?.revoked || status?.subscription === 'expired' }),
      });
      const result = (await response.json()) as DotStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? '无法准备连接');
      setSetup(result);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法准备连接');
    } finally {
      setBusy(false);
    }
  };
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setError('复制失败，请在当前设备允许剪贴板访问后重试。');
    }
  };
  const disconnect = async () => {
    if (!window.confirm('断开后将停止新的 dot 召唤。历史回复和已保存的图片保留。')) return;
    setBusy(true);
    try {
      const response = await apiFetch('/api/plugins/chatgpt-dot/disconnect', { method: 'POST' });
      if (!response.ok) throw new Error('断开失败，请重试。');
      setSetup(null);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '断开失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3" aria-label="dot 连接">
      <SettingsText as="h4" variant="sm" className="font-semibold">
        ChatGPT 云端 · dot 会话
      </SettingsText>
      <SettingsText as="p" variant="sm" tone="secondary">
        沿用 ChatGPT 已连接的猫咖插件，把订阅说明发给你要接入的那只 dot。回复和图片回到各自的原对话。
      </SettingsText>
      {error && (
        <p role="alert" className="text-sm text-conn-red-text">
          {error}
        </p>
      )}
      {installed && activationRequest > 0 && !activationAllowed && (
        <div ref={activationNotice} role="alert" tabIndex={-1} className="space-y-2 rounded-lg bg-conn-amber-bg p-3">
          <SettingsText as="p" variant="sm" tone="amber">
            {dotActivationFeedback(status, tests)}
          </SettingsText>
          <a
            href="https://chatgpt.com/plugins"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-cafe-secondary underline"
          >
            打开 ChatGPT 插件页面
          </a>
        </div>
      )}
      {!installed ? (
        <SettingsText as="p" variant="sm" tone="muted">
          在左边开启本机 dot 协作支持，再为目标 dot 准备订阅。ChatGPT 已有的连接不用重装。
        </SettingsText>
      ) : !status ? (
        <SettingsText as="p" variant="sm" tone="muted">
          正在读取连接状态…
        </SettingsText>
      ) : (
        <>
          <dl className="space-y-2 text-sm">
            <div className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-3 [&_dd]:min-w-0 [&_dd]:break-words">
              <dt>独立成员</dt>
              <dd>砚砚 · dot（@dot）</dd>
            </div>
            {status.ownerUserId && (
              <div className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-3 [&_dd]:min-w-0 [&_dd]:break-words">
                <dt>猫咖账号</dt>
                <dd>{status.ownerUserId}</dd>
              </div>
            )}
            <div className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-3 [&_dd]:min-w-0 [&_dd]:break-words">
              <dt>召唤订阅</dt>
              <dd>
                {status.revoked
                  ? '已断开'
                  : status.subscription === 'active'
                    ? '已验证'
                    : status.subscription === 'expired'
                      ? '需要重新订阅'
                      : '等待目标 dot 订阅'}
              </dd>
            </div>
            <div className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-3 [&_dd]:min-w-0 [&_dd]:break-words">
              <dt>原处回复</dt>
              <dd>{status.replyAt ? '收到过真实回复' : '尚未验证'}</dd>
            </div>
            <div className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-3 [&_dd]:min-w-0 [&_dd]:break-words">
              <dt>原图</dt>
              <dd>{status.imageAt ? '收到过原图' : '尚未验证'}</dd>
            </div>
          </dl>
          <SettingsText as="p" variant="sm" tone="muted">
            你的召唤仅读取来源对话。Pro 会话与 dot 会话共用一个连接，名字和头像分别显示。断开 dot 订阅不影响 Pro。
          </SettingsText>
          {!status.endpointUrl && (
            <SettingsText as="p" variant="sm" tone="muted">
              云端连接地址尚未配置，连接资料准备好后会显示在这里。
            </SettingsText>
          )}
          <button
            type="button"
            className={`${secondaryAction ? 'console-button-secondary' : 'console-button-primary'} min-h-8 !font-medium disabled:opacity-50`}
            disabled={busy || !status.endpointUrl}
            onClick={() => void prepare()}
          >
            {busy ? '准备中…' : status.paired ? '查看订阅说明' : '准备订阅说明'}
          </button>
          {setup?.endpointUrl && (
            <div className="space-y-3 rounded-lg border border-cafe p-3">
              <SettingsText as="p" variant="sm" tone="secondary">
                只为目标 dot 准备订阅，无需重新添加猫咖插件或更换 Pro 的连接口令。把下面的说明发给你的 dot。
              </SettingsText>
              <SettingsText as="p" variant="sm" tone="muted">
                若 ChatGPT 尚未连接猫咖，先按猫咖插件原有流程连接；不要另装一份 dot 连接。
              </SettingsText>
              <p className="break-words text-sm text-cafe-secondary">{setup.instructions}</p>
              <SettingsSecondaryButton onClick={() => void copy(setup.instructions ?? '', '说明')}>
                {copied === '说明' ? '说明已复制' : '复制订阅说明'}
              </SettingsSecondaryButton>
            </div>
          )}
          {status.paired && (
            <div className="space-y-3">
              <SettingsText as="p" variant="sm" tone="secondary">
                同时测两处原对话。收到、读过和回帖分别核实；两处都回到原处后再用左边开关启用。
              </SettingsText>
              <SettingsSecondaryButton
                disabled={busy || status.subscription !== 'active'}
                onClick={() => void testConnection()}
              >
                {tests.length ? '重新检查往返' : '测试两处往返'}
              </SettingsSecondaryButton>
              {tests.length > 0 && (
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left">来源</th>
                      <th>收到</th>
                      <th>读原文</th>
                      <th>原处回帖</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tests.map((test, index) => (
                      <tr key={test.eventId}>
                        <td className="py-2">
                          {test.threadId ? (
                            <a className="underline" href={`/thread/${encodeURIComponent(test.threadId)}`}>
                              测试 {index === 0 ? 'A' : 'B'}
                            </a>
                          ) : (
                            '来源待核'
                          )}
                        </td>
                        <td className="text-center">{test.receivedAt ? '✓' : '等待'}</td>
                        <td className="text-center">{test.readAt ? '✓' : '等待'}</td>
                        <td className="text-center">{test.replyMessageId ? '✓' : '等待'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {status.paired && (
            <SettingsSecondaryButton disabled={busy} onClick={() => void disconnect()}>
              断开这只 dot
            </SettingsSecondaryButton>
          )}
        </>
      )}
    </section>
  );
}
