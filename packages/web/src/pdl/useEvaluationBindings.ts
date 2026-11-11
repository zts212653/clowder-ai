'use client';
import type { PawFeelDutyConfig, PawFeelInboxPage } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import type { EvalHubSummary } from '@/components/HubEvalTypes';
import { isPawFeelInboxPage } from '@/components/paw-feel/paw-feel-page-guard';
import type { ChatData } from './chat-models';
import { request, write } from './owner-api';

interface EvaluationRead {
  summary: EvalHubSummary;
  duty: PawFeelDutyConfig | null;
  cats: { catId: string; handle: string; family: string }[];
  paw: PawFeelInboxPage;
}
export function useEvaluationBindings(data: ChatData, needed: boolean | number = false) {
  const [read, setRead] = useState<{ load: string; value?: EvaluationRead }>({ load: 'loading' });
  const [generation, refresh] = useState(0);
  const draft = useRef<{ primary?: string; backup?: string }>({});
  useEffect(() => {
    if (!needed) return; // Periodic while the evaluation projection is visible.
    const abort = new AbortController();
    const load = async () => {
      try {
        const [summary, duty, cats, paw] = await Promise.all([
          request<EvalHubSummary>('/api/eval-hub/summary', { signal: abort.signal }),
          request<{ config: PawFeelDutyConfig | null }>('/api/paw-feel/duty', { signal: abort.signal }),
          request<{ cats: EvaluationRead['cats'] }>('/api/eval-hub/available-cats', { signal: abort.signal }),
          (async () => {
            let cursor: string | undefined;
            let result: PawFeelInboxPage | undefined;
            do {
              const query = new URLSearchParams({ limit: '50', sort: 'newest' });
              if (cursor) query.set('cursor', cursor);
              const page = await request<unknown>(`/api/paw-feel/inbox?${query}`, { signal: abort.signal });
              if (!isPawFeelInboxPage(page, true) || page.projectionStatus !== 'available' || page.degraded)
                throw new Error('问题上报数据暂不可用');
              result = result
                ? {
                    ...page,
                    bundles: [...new Map([...result.bundles, ...page.bundles].map((b) => [b.bundleKey, b])).values()],
                    items: [
                      ...new Map([...result.items, ...page.items].map((i) => [i.disposition.signalId, i])).values(),
                    ],
                  }
                : page;
              cursor = page.nextCursor;
            } while (cursor);
            return result!;
          })(),
        ]);
        if (!abort.signal.aborted) setRead({ load: '', value: { summary, duty: duty.config, cats: cats.cats, paw } });
      } catch {
        if (!abort.signal.aborted) setRead((s) => ({ ...s, load: 'error' }));
      }
    };
    const poll = () => {
      if (!document.hidden) void load();
    };
    poll();
    const timer = setInterval(poll, 30000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [needed, generation]);
  const catLabel = (id: string) =>
    `${data.cats.find((c) => c.id === id)?.displayName ?? id} ${read.value?.cats.find((c) => c.catId === id)?.handle ?? ''}`.trim();
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'opEvalRun') {
      await write(
        `/api/eval-domains/${encodeURIComponent(args.k)}/${args.op === 'trigger' ? 'trigger-now' : 'generate-now'}`,
        {},
      );
      const summary = await request<EvalHubSummary>('/api/eval-hub/summary', undefined, { afterCurrentGet: true });
      setRead((current) => ({ load: '', value: current.value && { ...current.value, summary } }));
      return true;
    }
    if (name === 'opDutySave') {
      const current = read.value;
      if (!current) throw new Error('值班配置尚未读取');
      const cat = current.cats.find((c) => catLabel(c.catId) === args.v);
      draft.current = { ...draft.current, [args.field]: cat?.catId ?? '' };
      const sent = draft.current;
      const primaryCatId = draft.current.primary ?? current.duty?.primaryCatId,
        backupCatId = draft.current.backup ?? current.duty?.backupCatId;
      setRead((s) => ({ ...s }));
      if (!primaryCatId || !backupCatId) return true;
      if (primaryCatId === backupCatId) throw new Error('主值班与备用成员需要不同');
      const result = await write<{ config: PawFeelDutyConfig }>(
        '/api/paw-feel/duty',
        { expectedVersion: current.duty?.version ?? 0, primaryCatId, backupCatId },
        'PATCH',
      );
      if (draft.current === sent) draft.current = {};
      setRead((s) => ({ ...s, value: s.value && { ...s.value, duty: result.config } }));
      return true;
    }
    if (name === 'opDomCat') {
      const cat = read.value?.cats.find((c) => catLabel(c.catId) === args.v);
      if (!cat) throw new Error('请选择可用的评估成员');
      await write(`/api/eval-domains/${encodeURIComponent(args.k)}/eval-cat`, { catId: cat.catId }, 'PATCH');
      refresh((n) => n + 1);
      return true;
    }
    if (name === 'refresh' && args.k === 'eval') {
      refresh((n) => n + 1);
      return true;
    }
    return false;
  };
  return { action, data: read, state: draft };
}
