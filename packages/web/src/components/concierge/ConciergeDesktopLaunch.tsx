'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { showConciergeDesktop } from '@/stores/conciergeDesktopStore';
import { apiFetch } from '@/utils/api-client';
import type { OfficialPluginInfo } from '../settings/official-plugin-types';

type Phase = 'checking' | 'ready' | 'installing' | 'opening';
const failureMessage = (code: string) => {
  if (code === 'HOST_COMPONENT_UNAVAILABLE') return '桌面组件没有准备好，请重试安装。也可以先用文字聊天。';
  if (code === 'STALE_CATALOG' || code === 'STALE_REVISION') return '猫猫球状态刚刚改变，请重试。';
  return '暂时没能打开桌面猫猫球，请重试；已有聊天记录仍可继续使用。';
};
class LaunchError extends Error {
  constructor(readonly code: string) {
    super(failureMessage(code));
  }
}
async function readCompanion(signal: AbortSignal): Promise<OfficialPluginInfo> {
  const response = await apiFetch('/api/plugins/official', { signal });
  if (!response.ok) throw new LaunchError('UNAVAILABLE');
  const data = await response.json();
  const plugin: OfficialPluginInfo | undefined = Array.isArray(data.plugins)
    ? data.plugins.find((item: OfficialPluginInfo) => item.catalogId === 'companion')
    : undefined;
  if (!plugin || !plugin.packageDigest || !plugin.availableVersion) throw new LaunchError('UNAVAILABLE');
  return plugin;
}
async function mutate(path: string, body: object, signal: AbortSignal): Promise<OfficialPluginInfo> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw new LaunchError(typeof data.code === 'string' ? data.code : 'UNAVAILABLE');
  if (!data.instance?.pluginInstanceId || !Number.isInteger(data.instance.lifecycleRevision))
    throw new LaunchError('UNAVAILABLE');
  return data;
}

/** Explicit entry intent consumes the existing official lifecycle; opening never admits media. */
export function ConciergeDesktopLaunch({ onText, onClose }: { onText: () => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [plugin, setPlugin] = useState<OfficialPluginInfo>();
  const [error, setError] = useState<string>();
  const active = useRef<AbortController>();
  const working = useRef(false);
  const primary = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    void (async () => {
      try {
        const current = await readCompanion(controller.signal);
        if (controller.signal.aborted) return;
        setPlugin(current);
        if (current.instance?.runtimeState === 'healthy' && current.instance.activationState === 'enabled') {
          if (await showConciergeDesktop()) {
            if (!controller.signal.aborted) close.current();
            return;
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof LaunchError ? cause.message : failureMessage('UNAVAILABLE'));
      } finally {
        if (!controller.signal.aborted) setPhase('ready');
      }
    })();
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (phase === 'ready') primary.current?.focus();
  }, [phase]);

  const open = async () => {
    const controller = active.current;
    if (!controller || controller.signal.aborted || working.current) return;
    working.current = true;
    setError(undefined);
    setPhase('checking');
    try {
      let current = await readCompanion(controller.signal);
      if (controller.signal.aborted) return;
      if (!current.instance) {
        setPhase('installing');
        current = await mutate(
          '/api/plugins/official/companion/install',
          {
            expectedCatalogVersion: current.availableVersion,
            expectedPackageDigest: current.packageDigest,
          },
          controller.signal,
        );
      }
      if (controller.signal.aborted) return;
      setPlugin(current);
      setPhase('opening');
      const instance = current.instance;
      if (!instance) throw new LaunchError('UNAVAILABLE');
      if (instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy') {
        const action = instance.activationState === 'disabled' ? 'enable' : 'repair';
        await mutate(
          `/api/plugins/official/${encodeURIComponent(instance.pluginInstanceId)}/${action}`,
          { expectedRevision: instance.lifecycleRevision },
          controller.signal,
        );
      }
      if (controller.signal.aborted) return;
      if (!(await showConciergeDesktop())) throw new LaunchError('UNAVAILABLE');
      if (!controller.signal.aborted) close.current();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof LaunchError ? cause.message : failureMessage('UNAVAILABLE'));
    } finally {
      working.current = false;
      if (!controller.signal.aborted) setPhase('ready');
    }
  };
  const busy = phase !== 'ready';
  const leave = (action: () => void) => {
    active.current?.abort();
    action();
  };
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="companion-launch-title"
        className="w-full max-w-sm rounded-2xl border border-cafe-divider bg-cafe-surface p-5 shadow-xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            leave(onClose);
          }
          if (event.key === 'Tab') {
            const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            event.preventDefault();
            (
              buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length] as HTMLButtonElement
            )?.focus();
          }
        }}
      >
        <h2 id="companion-launch-title" className="text-base font-semibold">
          和猫猫在桌面聊聊
        </h2>
        <p className="mt-2 text-sm text-cafe-secondary">
          {plugin?.instance
            ? '继续使用当前猫猫和原有聊天记录。'
            : '首次使用会安装官方猫猫球，保留当前猫猫和原有聊天记录。'}
          打开窗口不会开麦；在桌面点击开始聊天后才使用麦克风。共享屏幕仍由你另行选择。
        </p>
        <p role={error ? 'alert' : 'status'} className="mt-3 text-sm text-cafe-secondary">
          {error ??
            (phase === 'installing'
              ? '正在准备桌面猫猫球，首次安装可能需要几分钟…'
              : phase === 'opening'
                ? '正在打开桌面猫猫球…'
                : phase === 'checking'
                  ? '正在确认猫猫球状态…'
                  : '')}
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="rounded-lg px-3 py-2 text-sm" onClick={() => leave(onClose)}>
            稍后
          </button>
          <button type="button" className="rounded-lg px-3 py-2 text-sm" onClick={() => leave(onText)}>
            先用文字
          </button>
          <button
            ref={primary}
            type="button"
            disabled={busy}
            onClick={() => void open()}
            className="rounded-lg bg-cafe-accent px-3 py-2 text-sm text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:opacity-50"
          >
            {busy ? '请稍候' : error ? '重试' : plugin?.instance ? '打开桌面' : '安装并打开'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
