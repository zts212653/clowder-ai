'use client';
import type { SignalArticle, SignalArticleStatus, SignalSource, SignalTier, StudyMeta } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPlaybackManager } from '@/services/playbackRuntime';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import {
  batchSignalArticles,
  createCollection,
  deleteSignalArticle,
  type FetchSourceResult,
  fetchCollections,
  fetchPodcastScript,
  fetchSignalArticle,
  fetchSignalSources,
  fetchSignalStats,
  fetchSignalsInbox,
  fetchStudyMeta,
  fetchStudyTimeline,
  generatePodcast,
  linkSignalThread,
  type PodcastScript,
  type SignalArticleDetail,
  type SignalArticleStats,
  type StudyCollection,
  searchSignals,
  type TimelineEntry,
  triggerSourceFetch,
  unlinkSignalThread,
  updateCollection,
  updateSignalArticle,
  updateSignalSource,
} from '@/utils/signals-api';
import { failRead, request, write } from './owner-api';

interface SignalUi {
  sigView: string;
  sigSt: string;
  sigTier: string;
  sigSrc: string;
  sigQ: string;
  sigSel: Record<string, boolean>;
  tlDays: string;
  fetchRes: string | FetchSourceResult['summary'];
  sigDetail?: string | null;
  pod?: number;
  playAll?: boolean;
  sigNote?: Record<string, string>;
}
export function useSignalBindings(ui: SignalUi, needed: boolean | number = false) {
  const playback = useRef<{ manager: ReturnType<typeof getPlaybackManager>; unsubscribe: () => void } | null>(null);
  const [playing, setPlaying] = useState<{ index: number; state: string }>({ index: -1, state: 'idle' });
  const stopPlayback = useCallback(() => {
    const active = playback.current;
    if (!active) return;
    active.unsubscribe();
    playback.current = null;
    active.manager.interrupt();
    ui.playAll = false;
    setPlaying({ index: -1, state: 'idle' });
  }, [ui]);
  useEffect(() => stopPlayback, [stopPlayback, ui.sigDetail, ui.pod]);
  const [read, setRead] = useState<{
    load: string;
    articles: readonly SignalArticle[];
    sources: readonly SignalSource[];
    stats: SignalArticleStats | null;
    timeline: readonly TimelineEntry[];
  }>({ load: 'loading', articles: [], sources: [], stats: null, timeline: [] });
  const [generation, refresh] = useState(0),
    [fetching, setFetching] = useState<string | null>(null);
  const epoch = useRef(0);
  const detailEpoch = useRef(0);
  const [detail, setDetail] = useState<{
    id: string;
    load: string;
    article?: SignalArticleDetail;
    meta?: StudyMeta;
    collections?: readonly StudyCollection[];
    note?: { id: string; at: string; content: string };
    podcast?: PodcastScript;
  }>({ id: '', load: 'loading' });
  const [discussion, setDiscussion] = useState<{ id: string; article: string } | null>(null);
  const openDetail = async (id: string) => {
    const stamp = ++detailEpoch.current;
    setDetail((s) => (s.id === id ? { ...s, load: 'loading' } : { id, load: 'loading' }));
    try {
      const [article, meta, collections] = await Promise.all([
        fetchSignalArticle(id),
        fetchStudyMeta(id),
        fetchCollections(),
      ]);
      const notes = meta.artifacts
        .filter((a) => a.kind === 'note' && a.state === 'ready')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const note = notes.find((n) => n.id === ui.sigNote?.[id]) ?? notes[0];
      const podcasts = meta.artifacts.filter((a) => a.kind === 'podcast' && a.state === 'ready');
      const pod = podcasts[ui.pod ?? 0];
      const [content, podcast] = await Promise.all([
        note
          ? request<{ content: string }>(
              `/api/signals/articles/${encodeURIComponent(id)}/notes/${encodeURIComponent(note.id)}`,
            )
          : Promise.resolve(null),
        pod?.state === 'ready' ? fetchPodcastScript(id, pod.id).then((r) => r.script) : Promise.resolve(undefined),
      ]);
      if (stamp === detailEpoch.current)
        setDetail({
          id,
          load: '',
          article,
          meta,
          collections,
          note: note && content ? { id: note.id, at: note.createdAt, content: content.content } : undefined,
          podcast,
        });
    } catch (error) {
      if (stamp === detailEpoch.current) setDetail((s) => ({ ...s, load: 'error' }));
      failRead(error);
    }
  };
  useEffect(
    () => () => {
      ++detailEpoch.current;
    },
    [],
  );
  useEffect(() => {
    if (!needed) return;
    const stamp = ++epoch.current;
    setRead((s) => ({ ...s, load: 'loading' }));
    void (async () => {
      try {
        const options = {
          limit: 100,
          status: ui.sigSt === 'all' ? undefined : (ui.sigSt as SignalArticleStatus),
          source: ui.sigSrc === 'all' ? undefined : ui.sigSrc,
          tier: ui.sigTier === 'all' ? undefined : (Number(ui.sigTier) as SignalTier),
        };
        const [sources, stats, articles, timeline] = await Promise.all([
          fetchSignalSources(),
          fetchSignalStats(),
          ui.sigQ.trim()
            ? searchSignals(ui.sigQ, options).then((r) => r.items)
            : fetchSignalsInbox({ ...options, status: ui.sigSt as 'all' | 'inbox' | 'read' | 'starred' | 'archived' }),
          ui.sigView === 'timeline'
            ? fetchStudyTimeline(Number(ui.tlDays)).then((r) => r.entries)
            : Promise.resolve([]),
        ]);
        if (stamp === epoch.current) setRead({ load: '', sources, stats, articles, timeline });
      } catch {
        if (stamp === epoch.current) setRead((s) => ({ ...s, load: 'error' }));
      }
    })();
    return () => {
      epoch.current++;
    };
  }, [needed, generation, ui.sigQ, ui.sigSrc, ui.sigSt, ui.sigTier, ui.sigView, ui.tlDays]);
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'sigNote') {
      if (
        detail.id !== args.id ||
        !detail.meta?.artifacts.some((n) => n.id === args.v && n.kind === 'note' && n.state === 'ready')
      )
        throw new Error('笔记已变化，请重新读取文章');
      (ui.sigNote ??= {})[args.id] = args.v;
      await openDetail(args.id);
      return true;
    }
    if (name === 'signalOpen') {
      if (ui.sigDetail !== args.id) {
        stopPlayback();
        ui.pod = 0;
      }
      ui.sigDetail = args.id;
      await openDetail(args.id);
      return true;
    }
    if (name === 'signalPod') {
      stopPlayback();
      await openDetail(ui.sigDetail!);
      return true;
    }
    if (name === 'signalPlayback' || name === 'signalSegment') {
      if (detail.id !== ui.sigDetail || !detail.podcast) throw new Error('播客尚未读取');
      const active = playback.current;
      if (active && name === 'signalPlayback' && active.manager.getState() === 'playing') {
        stopPlayback();
        return true;
      }
      if (
        active &&
        name === 'signalSegment' &&
        Number(args.i) === playing.index &&
        active.manager.getState() !== 'idle'
      ) {
        if (active.manager.getState() === 'paused') active.manager.resume();
        else active.manager.pause();
        return true;
      }
      const segments = detail.podcast.segments.flatMap((segment, i) =>
        segment.audioUrl && (name === 'signalPlayback' || i === Number(args.i)) ? [{ i, url: segment.audioUrl }] : [],
      );
      if (!segments.length) throw new Error('播客尚无可播放音频');
      stopPlayback();
      const manager = getPlaybackManager();
      const pending = manager.startBatch(
        segments.map((s) => s.url),
        apiFetch,
      );
      const unsubscribe = manager.subscribe((snapshot) => {
        ui.playAll = snapshot.source === 'podcast' && snapshot.state === 'playing';
        const index = snapshot.source === 'podcast' ? (segments[snapshot.itemIndex]?.i ?? -1) : -1;
        setPlaying((old) =>
          old.index === index && old.state === snapshot.state ? old : { index, state: snapshot.state },
        );
        if (snapshot.source !== 'podcast' && playback.current) {
          playback.current.unsubscribe();
          playback.current = null;
        }
      });
      playback.current = { manager, unsubscribe };
      await pending;
      return true;
    }
    if (
      ['signalTag', 'signalLink', 'signalCollection', 'signalNote', 'wsSigRefresh', 'wsDiscuss', 'wsPodGen'].includes(
        name,
      )
    ) {
      const id = args.k || ui.sigDetail!;
      if (!detail.article || detail.id !== id) throw new Error('文章详情尚未读取');
      if (name === 'signalTag')
        await updateSignalArticle(id, {
          tags:
            args.op === 'remove'
              ? detail.article.tags.filter((t) => t !== args.v)
              : [...new Set([...detail.article.tags, args.v.trim()])],
        });
      if (name === 'signalNote') await updateSignalArticle(id, { note: args.v });
      if (name === 'signalLink') {
        if (args.op === 'remove') await unlinkSignalThread(id, args.v);
        else await linkSignalThread(id, args.v);
      }
      if (name === 'signalCollection') {
        if (args.op === 'create') await createCollection(args.v, [id]);
        else {
          const owner = detail.collections!.find((c) => c.id === args.v);
          if (!owner) throw new Error('学习集已变化');
          await updateCollection(owner.id, { articleIds: [...new Set([...owner.articleIds, id])] });
        }
      }
      if (name === 'wsSigRefresh') {
        const result = await write<{ enriched: boolean; reason?: string }>(
          `/api/signals/articles/${encodeURIComponent(id)}/enrich`,
          {},
        );
        if (result.reason === 'fetch_failed') throw new Error('无法访问原始页面');
        if (result.reason === 'not_found') throw new Error('文章已不在来源中');
      }
      if (name === 'wsPodGen') await generatePodcast(id, args.v === 'brief' ? 'essence' : 'deep');
      if (name === 'wsDiscuss') {
        const result = await write<{ threadId: string }>(`/api/signals/articles/${encodeURIComponent(id)}/discuss`, {});
        const article = detail.article;
        const intent =
          args.v === 'multiCatResearch'
            ? '请组织多位成员共同研究这篇文章，汇总证据与分歧。'
            : args.v === 'learn'
              ? '请学习这篇文章并整理笔记。'
              : '请讨论这篇文章。';
        useChatStore.getState().setPendingChatInsert({
          threadId: result.threadId,
          text: `${intent}\n\n${article.title}\n${article.url}\n\n${article.content}`,
        });
        setDiscussion({ id: result.threadId, article: id });
      }
      if (ui.sigDetail === id) await openDetail(id);
      return true;
    }
    if (name === 'signalBrowse') {
      refresh((n) => n + 1);
      return true;
    }
    if (name === 'signalStatus') await updateSignalArticle(args.id, { status: args.v as SignalArticleStatus });
    else if (name === 'signalDelete') await deleteSignalArticle(args.id);
    else if (name === 'signalBatch') {
      const ids = Object.keys(ui.sigSel).filter((id) => ui.sigSel[id]);
      await batchSignalArticles(
        ids,
        args.v === 'del' ? 'delete' : 'update',
        args.v === 'del' ? undefined : { status: args.v as SignalArticleStatus },
      );
      ui.sigSel = {};
    } else if (name === 'signalBatchTag') {
      const ids = Object.keys(ui.sigSel).filter((id) => ui.sigSel[id]);
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const article = read.articles.find((a) => a.id === id) ?? (await fetchSignalArticle(id).catch(failRead));
          return updateSignalArticle(id, { tags: [...new Set([...article.tags, args.v.trim()])] });
        }),
      );
      refresh((n) => n + 1);
      const failure = results.find((r) => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      ui.sigSel = {};
    } else if (name === 'signalSourceStatus') {
      const sources = args.id === '*' ? read.sources : read.sources.filter((s) => s.id === args.id);
      const results = await Promise.allSettled(
        sources.map((s) => updateSignalSource(s.id, args.enabled as unknown as boolean)),
      );
      const current = await fetchSignalSources().catch(failRead);
      setRead((s) => ({ ...s, sources: current }));
      const failure = results.find((r) => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } else if (name === 'wsFetch') {
      setFetching(args.k);
      try {
        const { summary } = await triggerSourceFetch(args.k);
        ui.fetchRes = summary;
      } finally {
        setFetching(null);
      }
    } else if (name !== 'refresh' || !['signals', 'sources'].includes(args.k)) return false;
    else if (args.k === 'signals' && ui.sigDetail) await openDetail(ui.sigDetail);
    if (ui.sigDetail && ['signalStatus', 'signalDelete'].includes(name)) {
      if (name === 'signalDelete') {
        stopPlayback();
        ui.sigDetail = null;
        ++detailEpoch.current;
      } else await openDetail(ui.sigDetail);
    }
    refresh((n) => n + 1);
    return true;
  };
  const rawData = useMemo(
    () => ({ read, detail, fetching, discussion, playing }),
    [read, detail, fetching, discussion, playing],
  );
  return { action, data: rawData };
}
