'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../../hub-icons';
import { SettingsIconButton } from '../primitives/SettingsIconButton';
import { SettingsPrimaryButton } from '../primitives/SettingsPrimaryButton';
import { SettingsSecondaryButton } from '../primitives/SettingsSecondaryButton';

interface Source {
  id: string;
  url: string;
  branch?: string;
  origin: 'official' | 'environment' | 'user';
  status: 'pending' | 'ready' | 'error';
  pluginCount: number;
  error?: string;
}

export function PluginMarketplaceSettings({
  onChange,
  autoSynchronize = true,
}: {
  onChange?: () => Promise<void>;
  autoSynchronize?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const addForm = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const mounted = useRef(true);
  const busyRef = useRef(false);

  const request = useCallback(async (suffix: string, init?: RequestInit) => {
    const response = await apiFetch(`/api/plugin-manager/marketplaces${suffix}`, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? '插件仓库操作失败。');
    if (mounted.current) setSources(body.sources);
  }, []);

  const synchronize = useCallback(async () => {
    setSyncing(true);
    try {
      await request('/refresh', { method: 'POST' });
      await onChange?.();
      if (mounted.current) setError(null);
    } catch {
      if (mounted.current) setError('插件仓库同步失败，已安装的插件不受影响。');
    } finally {
      if (mounted.current) setSyncing(false);
    }
  }, [onChange, request]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    if (onChange && autoSynchronize)
      void request('')
        .then(() => {
          if (!cancelled) return synchronize();
        })
        .catch(() => {
          if (!cancelled && mounted.current) setError('无法读取插件仓库设置。');
        });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [onChange, request, synchronize, autoSynchronize]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        setOpen(false);
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []),
      ];
      if (!controls.length) return;
      event.preventDefault();
      const current = controls.indexOf(document.activeElement as HTMLElement);
      controls[(current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    };
    window.addEventListener('keydown', keyboard);
    return () => {
      window.removeEventListener('keydown', keyboard);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);

  const mutate = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChange?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '插件仓库操作失败。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const failures = sources.filter((source) => source.status === 'error').length;

  return (
    <>
      {syncing && (
        <span role="status" className="self-center text-xs text-cafe-muted">
          正在检查插件仓库…
        </span>
      )}
      <SettingsIconButton aria-label="管理插件仓库" title="管理插件仓库" onClick={() => setOpen(true)}>
        <HubIcon name="settings" className="h-4 w-4" />
      </SettingsIconButton>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
            <div
              ref={dialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
              className="flex max-h-[calc(100dvh-32px)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] shadow-lg"
            >
              <div className="shrink-0 p-4">
                <div className="flex items-center justify-between">
                  <h2 id={titleId} className="text-lg font-semibold text-cafe">
                    插件仓库
                  </h2>
                  <SettingsIconButton aria-label="关闭插件仓库" disabled={busy} onClick={() => setOpen(false)}>
                    <HubIcon name="x" className="h-4 w-4" />
                  </SettingsIconButton>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pt-0">
                <ul className="divide-y divide-[var(--console-border-soft)]">
                  {sources.map((source) => (
                    <li key={source.id} className="space-y-2 py-3">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium text-cafe">
                          {source.origin === 'official'
                            ? '官方插件仓库'
                            : source.url
                                .replace(/\.git$/, '')
                                .split(/[/:]/)
                                .at(-1)}
                        </span>
                        {source.origin !== 'user' ? (
                          <span className="text-xs text-cafe-muted">
                            {source.origin === 'official' ? '默认' : '部署预置'}
                          </span>
                        ) : (
                          <SettingsIconButton
                            aria-label={`移除 ${source.url} · ${source.branch ?? '默认分支'}`}
                            disabled={busy}
                            onClick={() => setRemoving(source.id)}
                          >
                            <HubIcon name="trash" className="h-4 w-4" />
                          </SettingsIconButton>
                        )}
                      </div>
                      <p title={source.url} className="truncate font-mono text-xs text-cafe-muted">
                        {source.url.replace(/^(https?|ssh):\/\//, '').replace(/\.git$/, '')}
                      </p>
                      <p className="text-xs text-cafe-secondary">分支：{source.branch ?? '默认分支'}</p>
                      <p className="text-xs text-cafe-secondary">
                        {syncing
                          ? '正在同步…'
                          : source.status === 'ready'
                            ? `已同步 · ${source.pluginCount} 个插件`
                            : source.status === 'error'
                              ? source.error
                              : '等待同步'}
                      </p>
                      {removing === source.id && (
                        <div className="space-y-2">
                          <p className="text-sm text-cafe-secondary">
                            移除这个仓库？其中未安装的插件将不再列出，已安装的插件不受影响。
                          </p>
                          <div className="flex justify-end gap-2">
                            <SettingsSecondaryButton disabled={busy} onClick={() => setRemoving(null)}>
                              取消
                            </SettingsSecondaryButton>
                            <SettingsSecondaryButton
                              disabled={busy}
                              onClick={() =>
                                void mutate(async () => {
                                  await request(`/${source.id}`, { method: 'DELETE' });
                                  setRemoving(null);
                                })
                              }
                            >
                              移除仓库
                            </SettingsSecondaryButton>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <form
                  ref={addForm}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (url.trim())
                      void mutate(async () => {
                        await request('', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({
                            url: url.trim(),
                            ...(branch.trim() ? { branch: branch.trim() } : {}),
                          }),
                        });
                        setUrl('');
                        setBranch('');
                      });
                  }}
                  className="space-y-2"
                >
                  <label htmlFor={`${titleId}-url`} className="text-sm font-medium text-cafe">
                    添加插件仓库
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      id={`${titleId}-url`}
                      value={url}
                      disabled={busy}
                      aria-label="插件仓库地址"
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="https://git.example.com/team/plugins.git"
                      className="w-full min-w-0 flex-1 rounded-lg bg-[var(--console-input-bg)] px-3 py-2 text-sm text-cafe outline-none"
                    />
                    <input
                      aria-label="分支名"
                      value={branch}
                      disabled={busy}
                      onChange={(event) => setBranch(event.target.value)}
                      placeholder="分支（可选）"
                      className="w-full min-w-0 flex-1 rounded-lg bg-[var(--console-input-bg)] px-3 py-2 text-sm text-cafe outline-none"
                    />
                    <SettingsPrimaryButton
                      onClick={() => addForm.current?.requestSubmit()}
                      disabled={busy || !url.trim()}
                    >
                      {busy ? '检查中…' : '添加'}
                    </SettingsPrimaryButton>
                  </div>
                </form>
                {error && (
                  <p role="alert" className="text-sm text-conn-red-text">
                    {error}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--console-border-soft)] p-4">
                {failures > 0 && (
                  <SettingsSecondaryButton disabled={syncing || busy} onClick={() => void synchronize()}>
                    重试同步
                  </SettingsSecondaryButton>
                )}
                <SettingsSecondaryButton disabled={busy} onClick={() => setOpen(false)}>
                  完成
                </SettingsSecondaryButton>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
