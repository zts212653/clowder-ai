'use client';
import { buildPreviewGatewayUrl, previewVisiblePageAttestationSchema } from '@cat-cafe/shared';
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getPreviewBridgeOrigin } from '@/components/workspace/preview-bridge-origin';
import { parsePreviewUrl } from '@/components/workspace/preview-url-utils';
import { useHmrStatus } from '@/components/workspace/useHmrStatus';
import type { ConsoleEntry } from '@/components/workspace/usePreviewBridge';
import {
  appendBridgeConsoleEntry,
  isAuthorizedBridgeMessage,
  saveBridgeScreenshot,
} from '@/components/workspace/usePreviewBridge';
import { previewVisiblePageAdmissionController as admission } from '@/lib/preview-visible-page-admission-controller';
import { useChatStore } from '@/stores/chatStore';
import type { ChatData } from './chat-models';
import { request, write } from './owner-api';

interface PreviewTab {
  id: string;
  port: number;
  path: string;
}
type PreviewConsoleEntry = ConsoleEntry & { id: string };
interface DiscoveredService {
  port: number;
  framework?: string;
  reachable: boolean;
  worktreeId: string;
  discoveredAt: number;
}
export function usePreviewBindings(data: ChatData, worktreeId: string | null = null, needed: boolean | number = false) {
  const { threadId } = data;
  const target = useChatStore((s) => (s.currentThreadId === threadId ? s.workspacePreview : undefined));
  const ui = useRef({
    tabs: [] as PreviewTab[],
    active: '',
    consoleOpen: false,
    filter: 'all',
    warn: '',
    console: [] as PreviewConsoleEntry[],
  }).current;
  const [gateway, setGateway] = useState<{ load: string; port: number }>({ load: 'loading', port: 0 });
  const [health, setHealth] = useState<{ key: string; reachable: boolean }>({ key: '', reachable: false });
  const [discovered, setDiscovered] = useState<{
    worktreeId: string | null;
    load: string;
    services: DiscoveredService[];
  }>({ worktreeId: null, load: '', services: [] });
  const [discoveryAttempt, retryDiscovery] = useState(0);
  const receipt = useRef<string | null>(null);
  const visible = needed;
  const [, changed] = useState(0);
  const consoleSequence = useRef(0);
  const setEntries: Dispatch<SetStateAction<ConsoleEntry[]>> = (update) => {
    const entries = typeof update === 'function' ? update(ui.console) : update;
    ui.console = entries.map((entry) =>
      'id' in entry ? (entry as PreviewConsoleEntry) : { ...entry, id: String(++consoleSequence.current) },
    );
    changed((n) => n + 1);
  };
  const frame = useRef<HTMLIFrameElement | null>(null),
    ready = useRef(false);
  const listeners = useRef<(() => void) | null>(null);
  const epoch = useRef(0);
  const capture = useRef<{
    frame: HTMLIFrameElement;
    src: string;
    thread: string;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const pending = useSyncExternalStore(admission.subscribe, admission.getSnapshot, () => null);
  const tab = ui.tabs.find((t) => t.id === ui.active);
  const src =
    tab?.port && gateway.port && health.key === `${threadId}:${tab.port}` && health.reachable
      ? buildPreviewGatewayUrl(gateway.port, tab.port, tab.path)
      : '';
  const hmr = useHmrStatus(gateway.port, tab?.port ?? 0, Boolean(visible));
  const live = useRef({
    threadId,
    src,
    port: tab?.port ?? 0,
    path: tab?.path ?? '/',
    visible,
    gatewayPort: gateway.port,
  });
  live.current = { threadId, src, port: tab?.port ?? 0, path: tab?.path ?? '/', visible, gatewayPort: gateway.port };
  const requestAdmission = () => {
    const current = live.current,
      proof = admission.getSnapshot();
    if (
      !current.visible ||
      !ready.current ||
      !frame.current ||
      frame.current.src !== current.src ||
      !proof ||
      proof.port !== current.port ||
      proof.path !== current.path
    )
      return;
    const origin = getPreviewBridgeOrigin(current.gatewayPort, current.port);
    if (!origin || proof.targetOrigin !== origin) return;
    frame.current.contentWindow!.postMessage(
      {
        type: 'visible-page-admission-request',
        source: 'cat-cafe-preview',
        eventId: proof.eventId,
        targetPort: proof.port,
        admission: proof.admission,
      },
      origin,
    );
  };
  const probe = async (port: number) => {
    const stamp = ++epoch.current;
    const result = await request<{ reachable: boolean }>(`/api/preview/target-health?port=${port}`);
    if (stamp === epoch.current && live.current.threadId === threadId) {
      setHealth({ key: `${threadId}:${port}`, reachable: result.reachable });
      if (!result.reachable) {
        const proof = admission.getSnapshot();
        if (proof?.port === port) admission.fail(proof.eventId, 'visible_page_unavailable');
      }
    }
  };
  useEffect(() => {
    if (!needed) return;
    const abort = new AbortController();
    void request<{ available: boolean; gatewayPort: number }>('/api/preview/status', { signal: abort.signal })
      .then((r) => {
        if (!abort.signal.aborted) setGateway({ load: '', port: r.available ? r.gatewayPort : 0 });
      })
      .catch(() => {
        if (!abort.signal.aborted) setGateway({ load: 'error', port: 0 });
      });
    return () => {
      abort.abort();
      ++epoch.current;
      listeners.current?.();
      capture.current?.reject(new Error('预览已离开'));
      capture.current = null;
    };
  }, [needed]);
  const ownerThread = useRef(threadId);
  useEffect(() => {
    if (ownerThread.current !== threadId) {
      ++epoch.current;
      capture.current?.reject(new Error('预览已切换对话'));
      capture.current = null;
      ui.tabs = [];
      ui.active = '';
      setEntries([]);
      receipt.current = null;
      ownerThread.current = threadId;
    }
    if (!target) return;
    if (!target.port) {
      changed((n) => n + 1);
      return;
    }
    let item = ui.tabs.find((t) => t.port === target.port && t.path === target.path);
    if (!item) {
      item = { id: crypto.randomUUID(), port: target.port, path: target.path };
      ui.tabs.push(item);
    }
    ui.active = item.id;
    ready.current = false;
    changed((n) => n + 1);
    const pending = probe(target.port),
      stamp = epoch.current;
    void pending.catch((error) => {
      if (stamp !== epoch.current) return;
      ui.warn = error.message;
      changed((n) => n + 1);
    });
  }, [threadId, target?.port, target?.path]);
  useEffect(() => {
    requestAdmission();
  }, [pending, visible, src]);
  useEffect(() => {
    if (!visible || !worktreeId) return;
    const abort = new AbortController();
    setDiscovered((current) =>
      current.worktreeId === worktreeId ? current : { worktreeId, load: 'loading', services: [] },
    );
    void request<DiscoveredService[]>('/api/preview/discovered?' + new URLSearchParams({ worktreeId }), {
      signal: abort.signal,
    }).then(
      (services) => {
        if (!abort.signal.aborted) setDiscovered({ worktreeId, load: '', services });
      },
      () => {
        if (!abort.signal.aborted) setDiscovered({ worktreeId, load: 'error', services: [] });
      },
    );
    return () => abort.abort();
  }, [visible, worktreeId, discoveryAttempt]);
  const navigate = async (address: string) => {
    const parsed = parsePreviewUrl(address);
    if (!parsed.valid || !parsed.port) throw new Error(parsed.error);
    const owner = threadId;
    const result = await write<{ allowed: boolean; reason?: string }>('/api/preview/open', { port: parsed.port });
    if (!result.allowed) throw new Error(result.reason ?? '端口未获准');
    const path = parsed.path ?? '/';
    if (path !== '/') await write('/api/preview/navigate', { port: parsed.port, url: path });
    if (live.current.threadId !== owner || useChatStore.getState().currentThreadId !== owner) return;
    capture.current?.reject(new Error('预览地址已变化'));
    capture.current = null;
    const current = ui.tabs.find((t) => t.id === ui.active);
    if (current) {
      current.port = parsed.port;
      current.path = path;
    } else {
      const next = { id: crypto.randomUUID(), port: parsed.port, path };
      ui.tabs.push(next);
      ui.active = next.id;
    }
    ui.warn = parsed.warning ?? '';
    receipt.current = null;
    ready.current = false;
    useChatStore.getState().setWorkspacePreview({ port: parsed.port, path });
    changed((n) => n + 1);
  };
  const action = async (name: string, args: Record<string, string>, element?: HTMLElement) => {
    if (name === 'refresh' && args.k === 'preview') {
      retryDiscovery((n) => n + 1);
      return true;
    }
    if (name === 'pvDiscovered') {
      const service =
        discovered.worktreeId === worktreeId && discovered.services.find((item) => item.port === Number(args.port));
      if (!service) throw new Error('预览服务已变化，请重新读取');
      await navigate('localhost:' + service.port);
      return true;
    }
    if (name === 'previewFrame') {
      const next = element as HTMLIFrameElement;
      if (next === frame.current) return true;
      listeners.current?.();
      frame.current = next;
      ready.current = false;
      const loaded = () => {
        ready.current = true;
        requestAdmission();
        changed((n) => n + 1);
      };
      const failed = () => {
        const proof = admission.getSnapshot();
        if (proof?.port === live.current.port) admission.fail(proof.eventId, 'visible_page_load_error');
      };
      changed((n) => n + 1);
      next.addEventListener('load', loaded);
      next.addEventListener('error', failed);
      listeners.current = () => {
        next.removeEventListener('load', loaded);
        next.removeEventListener('error', failed);
      };
      return true;
    }
    if (name === 'pvFrameMessage') {
      const event = args.event as unknown as MessageEvent,
        current = live.current;
      if (
        !current.src ||
        element !== frame.current ||
        frame.current.src !== current.src ||
        !isAuthorizedBridgeMessage(event, frame.current, current.gatewayPort, current.port)
      )
        return true;
      const message = event.data;
      if (
        message.type === 'console' &&
        ['log', 'info', 'warn', 'error'].includes(message.level) &&
        Array.isArray(message.args) &&
        Number.isFinite(message.timestamp)
      ) {
        appendBridgeConsoleEntry(
          {
            level: message.level,
            args: message.args.map((v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))),
            timestamp: message.timestamp,
          },
          setEntries,
          (open) => {
            ui.consoleOpen = open;
          },
        );
      }
      if (message.type === 'visible-page-attestation') {
        const parsed = previewVisiblePageAttestationSchema.safeParse(message.attestation);
        if (parsed.success && current.visible) admission.attest(parsed.data);
      }
      const shot = capture.current;
      if (shot && shot.frame === frame.current && shot.src === current.src && shot.thread === current.threadId) {
        if (message.type === 'screenshot-error') {
          capture.current = null;
          shot.reject(new Error('预览截图失败'));
          changed((n) => n + 1);
        }
        if (message.type === 'screenshot-result') {
          try {
            const url = await saveBridgeScreenshot(message.dataUrl);
            if (capture.current === shot) {
              receipt.current = url;
              capture.current = null;
              shot.resolve();
            }
          } catch (error) {
            if (capture.current === shot) {
              capture.current = null;
              shot.reject(error as Error);
            }
          }
          changed((n) => n + 1);
        }
      }
      return true;
    }
    if (name === 'pvGo') {
      await navigate(args.v);
      return true;
    }
    if (name === 'pvRetry' || (name === 'refresh' && args.k === 'preview')) {
      if (tab?.port) await probe(tab.port);
      return true;
    }
    if (name === 'pvShot') {
      if (!frame.current || !src || !ready.current || capture.current) throw new Error('预览尚未就绪');
      receipt.current = null;
      const result = new Promise<void>((resolve, reject) => {
        capture.current = { frame: frame.current!, src, thread: threadId, resolve, reject };
      });
      changed((n) => n + 1);
      frame.current.contentWindow!.postMessage(
        { type: 'screenshot-request', source: 'cat-cafe-preview' },
        getPreviewBridgeOrigin(gateway.port, tab!.port)!,
      );
      await result;
      return true;
    }
    if (name === 'pvTabAdd') {
      capture.current?.reject(new Error('预览标签已切换'));
      capture.current = null;
      ready.current = false;
      const item = { id: crypto.randomUUID(), port: 0, path: '/' };
      ui.tabs.push(item);
      ui.active = item.id;
      useChatStore.getState().setWorkspacePreview({ port: undefined, path: '/' });
      changed((n) => n + 1);
      return true;
    }
    if (name === 'pvTabSelect') {
      capture.current?.reject(new Error('预览标签已切换'));
      capture.current = null;
      ready.current = false;
      const owner = ui.tabs.find((t) => t.id === ui.active);
      if (owner) useChatStore.getState().setWorkspacePreview({ port: owner.port || undefined, path: owner.path });
      changed((n) => n + 1);
      return true;
    }
    if (name === 'pvTabClose') {
      const closing = ui.tabs.find((t) => t.id === args.id);
      if (closing?.port && !ui.tabs.some((t) => t.id !== closing.id && t.port === closing.port))
        await write('/api/preview/close', { port: closing.port });
      if (live.current.threadId !== threadId || useChatStore.getState().currentThreadId !== threadId) return true;
      if (ui.active === args.id) {
        capture.current?.reject(new Error('预览已关闭'));
        capture.current = null;
        ready.current = false;
      }
      ui.tabs = ui.tabs.filter((t) => t.id !== args.id);
      if (ui.active === args.id) {
        ui.active = ui.tabs.at(-1)?.id ?? '';
        const next = ui.tabs.at(-1);
        useChatStore.getState().setWorkspacePreview({ port: next?.port || undefined, path: next?.path ?? '/' });
      }
      changed((n) => n + 1);
      return true;
    }
    if (name === 'pvLogClear') {
      setEntries([]);
      return true;
    }
    return false;
  };
  const rawData = useMemo(
    () => ({
      gateway,
      health,
      pending,
      hmr,
      receipt: receipt.current,
      console: ui.console,
      warn: ui.warn,
      target,
      src: live.current.src,
      ready: ready.current,
      capturing: !!capture.current,
      threadId,
      discovered: discovered.worktreeId === worktreeId ? discovered : { worktreeId, load: '', services: [] },
    }),
    [
      gateway,
      health,
      pending,
      hmr,
      receipt.current,
      ui.console,
      ui.warn,
      target,
      src,
      ready.current,
      !!capture.current,
      threadId,
      discovered,
      worktreeId,
    ],
  );
  return {
    action,
    state: ui,
    data: rawData,
  };
}
