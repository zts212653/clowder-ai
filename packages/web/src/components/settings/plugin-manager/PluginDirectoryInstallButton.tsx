'use client';

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DirectoryBrowser } from '../../ThreadSidebar/DirectoryBrowser';
import { SettingsPrimaryButton } from '../primitives/SettingsPrimaryButton';
import { SettingsSecondaryButton } from '../primitives/SettingsSecondaryButton';
import { PluginInstallationProgress } from './PluginInstallationProgress';

const LAST_DIRECTORY_KEY = 'clowder.plugin-install.last-directory';

function cycleDialogFocus(container: HTMLElement | null, backwards: boolean) {
  if (!container) return;
  const targets = Array.from(container.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')).filter(
    (element) => !element.matches(':disabled'),
  );
  if (targets.length === 0) {
    container.focus();
    return;
  }
  const activeIndex = document.activeElement instanceof HTMLElement ? targets.indexOf(document.activeElement) : -1;
  const index = activeIndex < 0 && backwards ? 0 : activeIndex;
  targets[(index + (backwards ? -1 : 1) + targets.length) % targets.length]?.focus();
}

export function PluginDirectoryInstallButton({
  onInstall,
  renderTrigger,
}: {
  onInstall: (path: string) => Promise<void>;
  renderTrigger?: (open: () => void) => ReactNode;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialPath, setInitialPath] = useState<string | undefined>();
  const lastDirectory = useRef<string>();
  const inFlight = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);

  const openDialog = () => {
    try {
      lastDirectory.current = window.localStorage.getItem(LAST_DIRECTORY_KEY) || lastDirectory.current;
    } catch {
      /* Browsing still works when browser storage is unavailable. */
    }
    setInitialPath(lastDirectory.current);
    setOpen(true);
  };
  const selectDirectory = useCallback((path: string) => {
    setSelectedPath(path);
    lastDirectory.current = path;
    try {
      window.localStorage.setItem(LAST_DIRECTORY_KEY, path);
    } catch {
      /* Retain the selection for this mounted picker. */
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPath(null);
    setError(null);
  }, []);
  const close = useCallback(() => {
    if (inFlight.current) return;
    setOpen(false);
    clearSelection();
  }, [clearSelection]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    dialog.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key !== 'Tab') return;
      event.preventDefault();
      cycleDialogFocus(dialog.current, event.shiftKey);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [open, close]);

  const install = async () => {
    if (!selectedPath || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onInstall(selectedPath);
      setOpen(false);
      clearSelection();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '本地插件安装失败。');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      {renderTrigger ? (
        renderTrigger(openDialog)
      ) : (
        <SettingsSecondaryButton onClick={openDialog}>从本地目录安装</SettingsSecondaryButton>
      )}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
            <div
              ref={dialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-busy={busy}
              tabIndex={-1}
              className="flex max-h-[calc(100dvh-32px)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] shadow-lg"
            >
              <div className="shrink-0 p-4">
                <h2 id={titleId} className="text-lg font-semibold text-cafe">
                  从本地目录安装插件
                </h2>
                <p className="mt-1 text-sm text-cafe-secondary">
                  选择运行 Hub 的电脑上的插件包目录。安装后可配置并启用。
                </p>
              </div>
              <fieldset
                disabled={busy}
                className="min-h-0 min-w-0 flex-1 overflow-hidden border-0 p-0 disabled:opacity-60"
              >
                <div className="h-[min(50dvh,400px)] min-h-0">
                  <DirectoryBrowser
                    initialPath={initialPath}
                    onCurrentPathChange={selectDirectory}
                    onNavigationStart={clearSelection}
                    onVirtualLocationChange={clearSelection}
                    allowCreateDirectory={false}
                    onCancel={close}
                  />
                </div>
              </fieldset>
              <div className="shrink-0 space-y-3 border-t border-[var(--console-border-soft)] p-4">
                <p className="break-all font-mono text-xs text-cafe-secondary" aria-live="polite">
                  {selectedPath ? `已选择：${selectedPath}` : '请选择并打开插件包目录。'}
                </p>
                {error && (
                  <p role="alert" className="rounded-lg bg-conn-red-bg p-3 text-sm text-conn-red-text">
                    {error}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <SettingsSecondaryButton onClick={close} disabled={busy}>
                    取消
                  </SettingsSecondaryButton>
                  <SettingsPrimaryButton onClick={() => void install()} disabled={busy || !selectedPath}>
                    {busy ? <PluginInstallationProgress /> : '安装插件'}
                  </SettingsPrimaryButton>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
