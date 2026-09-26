'use client';

import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { SettingsPrimaryButton } from '../primitives/SettingsPrimaryButton';
import { SettingsSecondaryButton } from '../primitives/SettingsSecondaryButton';

export function PluginGitInstallButton({ onInstall }: { onInstall: (url: string) => Promise<void> }) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, open]);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setUrl('');
    setError(null);
  };

  const install = async () => {
    const candidate = url.trim();
    if (!candidate) {
      setError('请输入 Git 仓库地址。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onInstall(candidate);
      setOpen(false);
      setUrl('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Git 插件安装失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsSecondaryButton onClick={() => setOpen(true)}>从 Git 安装</SettingsSecondaryButton>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="flex max-h-[calc(100vh-32px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
            >
              <div className="min-h-0 flex-1 overflow-y-auto p-6">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 id={titleId} className="text-lg font-bold text-cafe">
                      从 Git 安装插件
                    </h2>
                    <p className="mt-1 text-sm text-cafe-secondary">
                      输入只读 Git 地址。Host 会浅克隆仓库，并走与本地目录相同的包校验和准入流程。 支持
                      https://、ssh://、git:// 或 file://。不支持 git@host:org/repo.git；请改用
                      ssh://git@host/org/repo.git。
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭"
                    disabled={busy}
                    onClick={close}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-cafe-muted transition hover:bg-[var(--console-modal-close-bg)] hover:text-[var(--console-modal-close-fg)] disabled:opacity-50"
                  >
                    ✕
                  </button>
                </div>
                <label className="mt-5 block text-sm font-semibold text-cafe" htmlFor={`${titleId}-url`}>
                  Git 仓库地址
                </label>
                <input
                  id={`${titleId}-url`}
                  aria-label="Git 仓库地址"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void install();
                  }}
                  placeholder="https://github.example.com/team/plugin.git"
                  className="mt-2 w-full rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-panel-bg)] px-3 py-2.5 text-sm text-cafe outline-none transition focus:border-cafe-accent disabled:opacity-60"
                />
                {error && (
                  <p role="alert" className="mt-3 rounded-xl bg-conn-red-bg px-3 py-2.5 text-sm text-conn-red-text">
                    {error}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--console-border-soft)] px-6 py-4">
                <SettingsSecondaryButton onClick={close} disabled={busy}>
                  取消
                </SettingsSecondaryButton>
                <SettingsPrimaryButton onClick={() => void install()} disabled={busy || url.trim().length === 0}>
                  {busy ? '安装中…' : '安装插件'}
                </SettingsPrimaryButton>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
