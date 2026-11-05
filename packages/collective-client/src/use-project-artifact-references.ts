import type { collectiveProjectArtifactListSchema } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function useProjectArtifactReferences(roadmapId: string) {
  const shared = useSharedArtifacts(),
    client = shared?.api?.projectReferences;
  const key = `${client?.namespace ?? ''}:${roadmapId}:${shared?.status ?? ''}`;
  const current = useRef(key);
  current.current = key;
  const sequence = useRef(0),
    running = useRef<string>(),
    visibleCount = useRef(30);
  const [state, setState] = useState<{
    key: string;
    feed?: ReturnType<typeof collectiveProjectArtifactListSchema.parse>;
    error?: string;
  }>({ key });
  const reload = useCallback(
    async (force = false) => {
      if (!client || !roadmapId || (running.current === key && !force)) return;
      const ticket = ++sequence.current;
      running.current = key;
      try {
        let feed = await client.list(roadmapId);
        while (feed.items.length < visibleCount.current && feed.nextOffset !== undefined) {
          const next = await client.list(roadmapId, { offset: feed.nextOffset, expectedSnapshot: feed.snapshot });
          if (
            next.total !== feed.total ||
            next.items.some((item) =>
              feed.items.some((previous) => previous.reference.referenceId === item.reference.referenceId),
            )
          )
            throw new Error('Reference pages changed');
          feed = { ...next, offset: 0, items: [...feed.items, ...next.items] };
        }
        if (current.current === key && ticket === sequence.current) setState({ key, feed });
      } catch {
        if (current.current === key && ticket === sequence.current)
          setState({ key, error: '项目引用暂时不可读，请重新读取。' });
      } finally {
        if (running.current === key && ticket === sequence.current) running.current = undefined;
      }
    },
    [client, roadmapId, key],
  );
  useEffect(() => {
    visibleCount.current = 30;
    setState({ key });
    void reload();
    const timer = window.setInterval(() => void reload(), 5000);
    const refresh = () => void reload();
    window.addEventListener('collective:project-artifacts-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      ++sequence.current;
      running.current = undefined;
      window.clearInterval(timer);
      window.removeEventListener('collective:project-artifacts-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [reload, key]);
  const more = async () => {
    const feed = state.key === key ? state.feed : undefined;
    if (!client || !feed || feed.nextOffset === undefined || running.current === key) return;
    const ticket = ++sequence.current;
    running.current = key;
    try {
      const next = await client.list(roadmapId, { offset: feed.nextOffset, expectedSnapshot: feed.snapshot });
      if (current.current !== key || ticket !== sequence.current) return;
      if (
        next.total !== feed.total ||
        next.items.some((item) =>
          feed.items.some((previous) => previous.reference.referenceId === item.reference.referenceId),
        )
      )
        throw new Error('Reference pages changed');
      visibleCount.current = feed.items.length + next.items.length;
      setState({ key, feed: { ...next, offset: 0, items: [...feed.items, ...next.items] } });
    } catch {
      if (current.current === key && ticket === sequence.current)
        setState({ key, error: '项目引用暂时不可读，请重新读取。' });
    } finally {
      if (running.current === key && ticket === sequence.current) running.current = undefined;
    }
  };
  return { client, reload, more, ...(state.key === key ? state : { key }), shared };
}
