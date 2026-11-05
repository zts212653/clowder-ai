import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import type { RichHtmlWidgetBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

/**
 * F232 PR-A — 按坐标读回 Works 里的 HTML 原块。
 *
 * 目录 DTO 只带 `sourceMessageId + widgetBlockId`；正文在打开时按坐标向服务端要，
 * 服务端复核 thread / message / 归属 / 可见性 / block id / `kind === 'html_widget'`。
 *
 * 四种结果必须分开，调用方不能把任何一种当成「预览成功」：
 *   - idle / loading：还没结果；
 *   - ready：服务端返回的正是这个块；
 *   - unavailable：404（不存在、坐标不符、不是 HTML、或没有查看权限）；
 *   - error：网络/5xx/响应形状不对——如实报错，不拿别的块凑数。
 */
export type WidgetBlockState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; block: RichHtmlWidgetBlock }
  | { status: 'unavailable' }
  | { status: 'error' };

export interface WidgetBlockResult {
  state: WidgetBlockState;
  reload: () => void;
}

function parseBlock(payload: unknown, expected: { messageId: string; blockId: string }): RichHtmlWidgetBlock | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as { messageId?: unknown; block?: unknown };
  if (body.messageId !== expected.messageId || !body.block || typeof body.block !== 'object') return null;
  const block = body.block as Record<string, unknown>;
  if (block.id !== expected.blockId || block.kind !== 'html_widget') return null;
  if (typeof block.html !== 'string') return null;
  if (block.v !== 1) return null;
  return {
    id: block.id,
    kind: 'html_widget',
    v: 1,
    html: block.html,
    ...(typeof block.title === 'string' ? { title: block.title } : {}),
    ...(typeof block.height === 'number' && Number.isFinite(block.height) ? { height: block.height } : {}),
  };
}

export function useArtifactWidgetBlock(artifact: ThreadArtifactDTO | null, threadId: string | null): WidgetBlockResult {
  // 只依赖原始坐标，不依赖 DTO 对象身份：父组件重渲染不该重新发请求。
  const coordinates =
    artifact?.type === 'widget' && threadId && artifact.sourceMessageId && artifact.widgetBlockId
      ? { threadId, messageId: artifact.sourceMessageId, blockId: artifact.widgetBlockId }
      : null;
  const key = coordinates ? `${coordinates.threadId}\0${coordinates.messageId}\0${coordinates.blockId}` : '';
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; state: WidgetBlockState }>({
    key: '',
    state: { status: 'idle' },
  });

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const thread = coordinates?.threadId ?? null;
  const messageId = coordinates?.messageId ?? null;
  const blockId = coordinates?.blockId ?? null;
  useEffect(() => {
    if (!thread || !messageId || !blockId) {
      setLoaded({ key, state: { status: 'idle' } });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoaded({ key, state: { status: 'loading' } });
    const path =
      `/api/threads/${encodeURIComponent(thread)}/artifacts/` +
      `${encodeURIComponent(messageId)}/blocks/${encodeURIComponent(blockId)}`;
    apiFetch(path, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404 || response.status === 403) {
          if (!cancelled) setLoaded({ key, state: { status: 'unavailable' } });
          return;
        }
        if (!response.ok) throw new Error(`widget block read failed: ${response.status}`);
        const block = parseBlock(await response.json(), { messageId, blockId });
        if (!cancelled) setLoaded({ key, state: block ? { status: 'ready', block } : { status: 'error' } });
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setLoaded({ key, state: { status: 'error' } });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, thread, messageId, blockId, attempt]);

  // 坐标变化后、effect 跑完前，旧结果不能当成新块的预览。
  if (!coordinates) return { state: { status: 'idle' }, reload };
  if (loaded.key !== key) return { state: { status: 'loading' }, reload };
  return { state: loaded.state, reload };
}
