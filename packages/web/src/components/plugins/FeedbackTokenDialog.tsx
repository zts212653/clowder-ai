'use client';

import type { PluginManagerDetailResponse } from '@cat-cafe/shared';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { configurationRequest } from '../settings/plugin-manager/plugin-manager-live-api';
import { mutationRequestOptions } from '../settings/plugin-manager/plugin-manager-mutation-options';

export function FeedbackTokenDialog({
  provider,
  instanceId,
  onCancel,
  onResume,
}: {
  provider: 'github' | 'gitlab';
  instanceId: string;
  onCancel: () => void;
  onResume: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const name = provider === 'github' ? 'GitHub' : 'GitLab';
  const label = `${name} 访问令牌`;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => element?.close();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const value = input.current?.value.trim() ?? '';
    if (!saved && !value) {
      setError('请输入访问令牌。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (!saved) {
        const detail = await apiFetch('/api/plugin-manager/plugins/_local/official.feedback', undefined, {
          afterCurrentGet: true,
          notifyFailure: false,
        });
        if (!detail.ok) throw new Error('detail unavailable');
        const { plugin } = (await detail.json()) as PluginManagerDetailResponse;
        const key = provider === 'github' ? 'githubToken' : 'gitlabToken';
        if (
          plugin?.pluginId !== 'official.feedback' ||
          plugin.pluginInstanceId !== instanceId ||
          !plugin.configFields?.some((field) => field.key === key && field.kind === 'secret')
        ) {
          setError('当前反馈插件配置已变化。请返回报告后重新打开配置。');
          return;
        }
        const request = configurationRequest(plugin, [{ key, value }]);
        if (!request) throw new Error('configuration unavailable');
        const response = await apiFetch(request.path, request.init, {
          ...mutationRequestOptions(request.path),
          notifyFailure: false,
        });
        if (!response.ok) {
          setError(response.status === 409 ? '配置已变化，请重试。' : '无法保存令牌，请重试。');
          return;
        }
        setSaved(true);
      }
      await onResume().catch(() => setError('令牌已保存，暂时无法返回报告。请重试。'));
    } catch {
      setError('未能确认令牌保存，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className="m-auto w-[calc(100%-2rem)] max-w-[420px] rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-panel-bg)] p-5 text-cafe shadow-xl backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <form onSubmit={(event) => void save(event)} className="space-y-4">
        <div>
          <h3 id={titleId} className="text-base font-semibold">
            配置 {label}
          </h3>
          <p className="mt-1 text-sm text-cafe-secondary">保存后会返回当前报告并检查自动提交条件。</p>
        </div>
        {!saved && (
          <label className="block space-y-1.5 text-sm">
            <span>{label}</span>
            <input
              ref={input}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              required
              disabled={busy}
              onChange={() => setError('')}
              className="shell-focusable block w-full rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface px-3 py-2 text-sm"
            />
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="shell-focusable rounded-lg px-3 py-2 text-sm hover:bg-[var(--console-hover-bg)]"
            disabled={busy}
            onClick={onCancel}
          >
            {saved ? '关闭' : '取消'}
          </button>
          <button
            type="submit"
            className="shell-focusable rounded-lg bg-cafe-accent px-3 py-2 text-sm text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:opacity-50"
            disabled={busy}
          >
            {busy ? (saved ? '正在返回…' : '正在保存…') : saved ? '重试返回报告' : '保存并继续'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
