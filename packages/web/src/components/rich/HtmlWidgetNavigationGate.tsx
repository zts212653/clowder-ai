'use client';

import { type RefObject, useEffect, useState } from 'react';

type Destination = { href: string; label: string };
const RESERVED_PORTS = new Set([
  3001, 3002, 3003, 3004, 6397, 6398, 6399, 18888, 19999, 9876, 9877, 9878, 9879, 9880, 9881,
]);

/** Requests grant no navigation authority: the host still requires a visible native click. */
export function resolveWidgetNavigation(value: unknown, origin: string): Destination | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  const query = [...url.searchParams];
  if (
    value.startsWith('/thread/') &&
    url.origin === origin &&
    /^\/thread\/thread_[A-Za-z0-9_-]{1,193}$/.test(url.pathname) &&
    query.length === 1 &&
    (query[0]?.[0] === 'message' || query[0]?.[0] === 'messageId') &&
    /^[A-Za-z0-9_-]{1,200}$/.test(query[0][1])
  ) {
    url.search = new URLSearchParams({ message: query[0][1] }).toString();
    return { href: url.href, label: '打开原消息' };
  }
  if (
    url.origin === 'https://www.openstreetmap.org' &&
    /^\/(way|node|relation)\/\d+$/.test(url.pathname) &&
    !query.length
  ) {
    return { href: url.href, label: '打开地图' };
  }
  if (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.pathname === '/' &&
    Number(url.port) >= 1024 &&
    Number(url.port) <= 65535 &&
    !RESERVED_PORTS.has(Number(url.port)) &&
    (!query.length || (query.length === 1 && query[0]?.[0] === 'asset' && /^[a-f0-9]{64}$/.test(query[0][1])))
  ) {
    return { href: url.href, label: '打开本机页面' };
  }
  return null;
}

export function HtmlWidgetNavigationGate({
  iframeRef,
  contentKey,
}: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  contentKey: string;
}) {
  const [pending, setPending] = useState<(Destination & { contentKey: string }) | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        !iframeRef.current?.contentWindow ||
        event.source !== iframeRef.current.contentWindow ||
        event.origin !== 'null'
      )
        return;
      if (!event.data || typeof event.data !== 'object') return;
      const request = event.data as Record<string, unknown>;
      if (request.type !== 'cat-cafe:html-widget-navigation' || request.v !== 1) return;
      const destination = resolveWidgetNavigation(request.href, window.location.origin);
      if (destination) {
        setPending({ ...destination, contentKey });
        iframeRef.current.contentWindow.postMessage({ type: 'cat-cafe:html-widget-navigation-ready', v: 1 }, '*');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [contentKey, iframeRef]);

  if (!pending || pending.contentKey !== contentKey) return null;
  return (
    <output
      data-widget-navigation
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-cafe bg-cafe-surface-elevated px-3 py-2 text-xs text-cafe-primary"
    >
      <span className="min-w-0 flex-1 break-all">此作品请求打开：{pending.href}</span>
      <a
        href={pending.href}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-md px-3 py-1.5 font-semibold text-cafe-accent hover:bg-cafe-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
      >
        {pending.label} ↗
      </a>
      <button
        type="button"
        onClick={() => setPending(null)}
        className="rounded-md px-2 py-1.5 text-cafe-secondary hover:bg-cafe-surface"
      >
        取消
      </button>
    </output>
  );
}
