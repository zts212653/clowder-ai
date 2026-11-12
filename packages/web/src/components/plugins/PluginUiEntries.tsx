'use client';

import type { PluginIconSpec } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { PluginVisual } from '../settings/plugin-manager/PluginVisual';
import { copyPanelImage, pluginPanelChannel, sandboxedPanelHtml } from './plugin-panel-bridge';
import { requestPluginHttp } from './plugin-panel-http';

interface Entry {
  pluginId: string;
  instanceId: string;
  commandId: string;
  resourcePath: string;
  label: string;
  generation: string;
  icon?: PluginIconSpec;
}
/** Package UI runs in an opaque sandbox, never as scripts in the Host origin. */
export function PluginUiEntries() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [active, setActive] = useState<Entry>();
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const nonce = useRef('');
  const lifetime = useRef<AbortController>();
  const closeGuard = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch('/api/plugin-ui');
      if (!response.ok) {
        setEntries([]);
        return;
      }
      const value = await response.json();
      setEntries(Array.isArray(value.entries) ? value.entries : []);
    } catch {
      /* Retry on focus and lifecycle polling. */
    }
  }, []);
  useEffect(() => {
    void refresh();
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 15_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      lifetime.current?.abort();
    };
  }, [refresh]);
  const close = useCallback(() => {
    lifetime.current?.abort();
    dialog.current?.close();
    setActive(undefined);
    setHtml('');
    setError('');
    setClosing(false);
    closeGuard.current = false;
  }, []);
  const requestClose = () => {
    if (closing) return;
    if (!closeGuard.current) return close();
    setClosing(true);
    frame.current?.contentWindow?.postMessage(
      { channel: pluginPanelChannel, nonce: nonce.current, type: 'before-close' },
      '*',
    );
  };
  useEffect(() => {
    if (
      active &&
      !entries.some(
        (e) =>
          e.instanceId === active.instanceId && e.commandId === active.commandId && e.generation === active.generation,
      )
    )
      close();
  }, [active, entries, close]);
  useEffect(() => {
    if (!active) return;
    dialog.current?.showModal();
    const pending = new Set<number>();
    const handle = async (event: MessageEvent) => {
      const data: unknown = event.data;
      if (event.source !== frame.current?.contentWindow || !data || typeof data !== 'object') return;
      const message = data as Record<string, unknown>;
      if (
        message.channel !== pluginPanelChannel ||
        message.nonce !== nonce.current ||
        !Number.isSafeInteger(message.requestId)
      )
        return;
      const requestId = message.requestId as number;
      if (pending.has(requestId) || pending.size >= 16 || JSON.stringify(data).length > 24_000_000) return;
      pending.add(requestId);
      const target = frame.current?.contentWindow;
      const token = nonce.current;
      try {
        let result: unknown;
        if (message.type === 'close') {
          close();
          return;
        }
        if (message.type === 'close.guard') {
          closeGuard.current = message.value === true;
          result = true;
        } else if (message.type === 'close.cancel') {
          setClosing(false);
          result = true;
        } else if (message.type === 'clipboard.text') {
          if (typeof message.value !== 'string' || message.value.length > 120_000) throw new Error('复制内容无效');
          await navigator.clipboard.writeText(message.value);
          result = true;
        } else if (message.type === 'clipboard.image') {
          await copyPanelImage(message.value);
          result = true;
        } else if (message.type === 'http')
          result = await requestPluginHttp(active, message.request, lifetime.current?.signal);
        else throw new Error('不支持的插件面板请求');
        if (token === nonce.current && target === frame.current?.contentWindow)
          target?.postMessage({ channel: pluginPanelChannel, nonce: token, requestId, result }, '*');
      } catch (failure) {
        if (token === nonce.current)
          target?.postMessage(
            {
              channel: pluginPanelChannel,
              nonce: token,
              requestId,
              error: failure instanceof Error ? failure.message : '操作未完成',
            },
            '*',
          );
      } finally {
        pending.delete(requestId);
      }
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [active, close]);
  async function open(entry: Entry) {
    lifetime.current?.abort();
    const controller = new AbortController();
    lifetime.current = controller;
    nonce.current = crypto.randomUUID();
    closeGuard.current = false;
    setClosing(false);
    setError('');
    setHtml('');
    setActive(entry);
    try {
      const resource = await requestPluginHttp(entry, { method: 'GET', path: entry.resourcePath }, controller.signal);
      if (controller.signal.aborted || lifetime.current !== controller) return;
      if (
        resource.status < 200 ||
        resource.status >= 300 ||
        resource.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/html'
      )
        throw new Error('插件页面加载失败，请检查插件状态');
      setHtml(sandboxedPanelHtml(resource.body));
    } catch (failure) {
      if (controller.signal.aborted || lifetime.current !== controller) return;
      setError(failure instanceof Error ? failure.message : '面板打开失败');
    }
  }
  return (
    <>
      {entries.map((entry) => (
        <button
          key={`${entry.instanceId}:${entry.commandId}`}
          type="button"
          title={entry.label}
          aria-label={entry.label}
          onClick={() => void open(entry)}
          className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--console-rail-item)]"
        >
          <PluginVisual icon={entry.icon ?? 'plug'} name={entry.label} />
        </button>
      ))}
      {active &&
        createPortal(
          <dialog
            ref={dialog}
            aria-label={active.label}
            onCancel={(event) => {
              event.preventDefault();
              requestClose();
            }}
            className="m-auto h-[min(900px,94dvh)] w-[min(820px,96vw)] max-w-none overflow-hidden rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-bg)] p-0 shadow-2xl backdrop:bg-black/40"
          >
            <div className="absolute right-3 top-2 z-10">
              <button
                type="button"
                aria-label="关闭插件面板"
                onClick={requestClose}
                disabled={closing}
                className="rounded px-2 py-1 hover:bg-black/10"
              >
                ×
              </button>
            </div>
            {error ? (
              <p role="alert" className="p-8">
                {error}
              </p>
            ) : html ? (
              <iframe
                ref={frame}
                title={active.label}
                name={nonce.current}
                sandbox="allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox"
                referrerPolicy="no-referrer"
                srcDoc={html}
                className="h-full w-full border-0"
              />
            ) : (
              <p role="status" className="p-8">
                正在打开…
              </p>
            )}
          </dialog>,
          document.body,
        )}
    </>
  );
}
