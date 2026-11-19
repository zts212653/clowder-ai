'use client';
import type { AnnotationSet, BacklogItem, FeatureStoryRenderingDTO } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { extractFeatureId } from '@/components/mission-control/feature-id';
import { getDemoDeliverableHtml } from '@/components/onboarding-demo/demo-deliverable';
import { getDemoEvents, getDemoTeam } from '@/components/onboarding-demo/demo-story';
import { adaptTranscriptEvents } from '@/lib/story-player/adapter';
import { annotateAdaptivePacing } from '@/lib/story-player/adaptive-pacing';
import { extractChapters } from '@/lib/story-player/chapters';
import { mergeFeatureEvents } from '@/lib/story-player/feature-replay-merger';
import { buildReplayChatMessages } from '@/lib/story-player/replay-chat-bridge';
import {
  compressEventTimestamps,
  createReplayEngine,
  pause,
  play,
  seek,
  setDisplayMode,
  setSpeed,
  tick,
  toggleAdaptivePacing,
} from '@/lib/story-player/replay-engine';
import { fetchThreadReplayEvents } from '@/lib/story-player/thread-replay-fetcher';
import type { ReplayEngineState, ReplayEvent, SpeedMultiplier } from '@/lib/story-player/types';
import type { ChatMessage } from '@/stores/chat-types';
import { request as ownerRead, write } from './owner-api';

export function useReplayBindings(featureItems: readonly BacklogItem[] = [], needed: boolean | number = false) {
  const [thread, setThread] = useState<string | null>(null);
  const [source, setSource] = useState('thread');
  const [threadStoryId, setThreadStoryId] = useState<string | null>(null);
  const storyId = source === 'thread' ? threadStoryId : source === 'guide' ? null : 'feat:' + source;
  const [annotations, setAnnotations] = useState<{
    storyId: string | null;
    load: string;
    value: AnnotationSet | null;
    error: string;
  }>({ storyId: null, load: '', value: null, error: '' });
  useEffect(() => {
    if (!needed || !storyId) return;
    const abort = new AbortController();
    setAnnotations((current) =>
      current.storyId === storyId ? current : { storyId, load: 'loading', value: null, error: '' },
    );
    void ownerRead<AnnotationSet>('/api/story/' + encodeURIComponent(storyId) + '/annotations', {
      signal: abort.signal,
    }).then(
      (value) => {
        if (!abort.signal.aborted) setAnnotations({ storyId, load: '', value, error: '' });
      },
      (error: Error) => {
        if (!abort.signal.aborted) setAnnotations({ storyId, load: 'error', value: null, error: error.message });
      },
    );
    return () => abort.abort();
  }, [needed, storyId]);
  const [guideLanguage, setGuideLanguage] = useState<'zh' | 'en'>('zh');
  const guideScript = useMemo(() => getDemoEvents(guideLanguage), [guideLanguage]);
  const guideHtml = useMemo(() => getDemoDeliverableHtml(guideLanguage), [guideLanguage]);
  const guideTeam = useMemo(() => getDemoTeam(guideLanguage), [guideLanguage]);
  const [attempt, retry] = useState(0);
  const [read, setRead] = useState<{
    thread: string | null;
    load: string;
    events: ReplayEvent[];
    eventTimes: number[];
    engine: ReplayEngineState;
    typingMs: number | null;
  }>({ thread: null, load: 'loading', events: [], eventTimes: [], engine: createReplayEngine([]), typingMs: null });
  const typing = read.typingMs !== null;
  const request = useRef(0);
  useEffect(() => {
    if (!needed || !thread) return;
    const generation = ++request.current;
    setRead((s) =>
      s.thread === thread
        ? s
        : { ...s, thread, load: 'loading', events: [], engine: createReplayEngine([]), typingMs: null },
    );
    const fetchEvents = async () => {
      if (source === 'thread') return fetchThreadReplayEvents(thread);
      const rendering = await ownerRead<FeatureStoryRenderingDTO>(
        `/api/story/feat:${encodeURIComponent(source)}/rendering`,
      );
      const sets = await Promise.all(
        rendering.lanes.map(async (lane) => [lane.threadId, await fetchThreadReplayEvents(lane.threadId)] as const),
      );
      return mergeFeatureEvents(new Map(sets));
    };
    void fetchEvents()
      .then((raw) => {
        if (generation !== request.current) return;
        const sourceEvents = adaptTranscriptEvents(raw);
        const events = compressEventTimestamps(annotateAdaptivePacing(sourceEvents));
        setRead({
          thread,
          load: '',
          events,
          eventTimes: sourceEvents.map((event) => event.timestamp),
          engine: createReplayEngine(events),
          typingMs: null,
        });
      })
      .catch(() => {
        if (generation === request.current) setRead((s) => ({ ...s, load: 'error' }));
      });
    return () => {
      ++request.current;
    };
  }, [needed, thread, source, attempt]);
  useEffect(() => {
    if (!needed || (read.engine.state !== 'playing' && !typing)) return;
    let frame: number, previous: number | undefined;
    const advance = (at: number) => {
      const delta = previous === undefined ? 0 : at - previous;
      previous = at;
      setRead((s) => {
        if (s.typingMs !== null) {
          const typingMs = s.typingMs + delta,
            length = s.events[s.engine.currentIndex].content.length,
            step = Math.max(2, Math.round(length / 24));
          return { ...s, typingMs: Math.floor(typingMs / 40) * step >= length ? null : typingMs };
        }
        const engine = tick(s.engine, delta),
          event = s.events[engine.currentIndex];
        const typing =
          engine.currentIndex !== s.engine.currentIndex &&
          engine.displayMode === 'cinematic' &&
          engine.speed !== 'max' &&
          event?.type === 'message' &&
          event.role === 'assistant' &&
          event.content.length > 0;
        return { ...s, engine, typingMs: typing ? 0 : null };
      });
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [needed, read.engine.state, typing]);
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'refresh' && args.k === 'replay' && thread) {
      retry((n) => n + 1);
      return true;
    }
    if (name === 'guideOpen') {
      const language = args.language === 'en' ? 'en' : 'zh';
      let timestamp = 0;
      const events: ReplayEvent[] = getDemoEvents(language).map((event, index) => {
        const at = timestamp;
        timestamp += event.duration;
        return {
          index,
          eventNo: index,
          timestamp: at,
          type: 'message',
          role: event.speaker === 'user' || event.speaker === 'system' ? event.speaker : 'assistant',
          content: event.text,
          ...(event.speaker === 'user' || event.speaker === 'system' ? {} : { catId: `guide:${event.speaker}` }),
        };
      });
      setThread(null);
      setSource('guide');
      setGuideLanguage(language);
      setRead({
        thread: null,
        load: '',
        events,
        eventTimes: events.map((event) => event.timestamp),
        engine: play(setSpeed(createReplayEngine(events), 1)),
        typingMs: null,
      });
      return true;
    }
    if (name === 'replayOpen') {
      setThread(args.id);
      setSource('thread');
      setThreadStoryId(args.storyId || null);
      return true;
    }
    if (name === 'rpAnnotate') {
      const content = args.v.trim();
      if (!content) return false;
      if (args.storyId !== storyId) throw new Error('故事来源已变化，请重新读取');
      const path = '/api/story/' + encodeURIComponent(args.storyId) + '/annotations';
      try {
        await write(path, { at: Number(args.at), kind: 'narration', content });
        const value = await ownerRead<AnnotationSet>(path);
        setAnnotations((reading) =>
          reading.storyId === args.storyId ? { storyId: args.storyId, load: '', value, error: '' } : reading,
        );
      } catch (error) {
        setAnnotations((reading) =>
          reading.storyId === args.storyId ? { ...reading, error: (error as Error).message } : reading,
        );
        throw error;
      }
      return true;
    }
    if (name === 'rpSource') {
      if (args.v !== 'thread' && !featureItems.some((item) => extractFeatureId(item.tags) === args.v))
        throw new Error('播放来源已变化');
      setSource(args.v);
      setRead((read) => ({ ...read, engine: pause(read.engine), typingMs: null }));
      return true;
    }
    if (name === 'replayClose') {
      setRead((s) => ({ ...s, engine: pause(s.engine), typingMs: null }));
      return true;
    }
    if (!['rpPlay', 'rpSeek', 'rpSpeed', 'rpMode', 'rpSkip'].includes(name)) return false;
    setRead((s) => {
      let engine = s.engine;
      if (name === 'rpPlay') engine = engine.state === 'playing' || s.typingMs !== null ? pause(engine) : play(engine);
      if (name === 'rpSeek') engine = seek(pause(engine), Number(args.v));
      if (name === 'rpSpeed') engine = setSpeed(engine, args.v === 'max' ? 'max' : (Number(args.v) as SpeedMultiplier));
      if (name === 'rpMode') engine = setDisplayMode(engine, args.v as 'cinematic' | 'faithful');
      if (name === 'rpSkip' && engine.adaptivePacing !== (args.v as unknown as boolean))
        engine = toggleAdaptivePacing(engine);
      return { ...s, engine, typingMs: ['rpPlay', 'rpSeek', 'rpMode'].includes(name) ? null : s.typingMs };
    });
    return true;
  };
  const { events, typingMs } = read,
    current = read.engine.currentIndex;
  const messages = useMemo(() => {
    const visible = events.slice(0, current + 1);
    if (typingMs !== null) {
      const event = events[current],
        step = Math.max(2, Math.round(event.content.length / 24));
      visible[current] = { ...event, content: event.content.slice(0, Math.floor(typingMs / 40) * step) };
    }
    const messages: ChatMessage[] = buildReplayChatMessages(visible).map((m, index, all) => ({
      ...m,
      isStreaming: typingMs !== null && index === all.length - 1,
      origin: m.cliStdout === undefined ? undefined : 'stream',
      extra: m.cliStdout === undefined ? undefined : { stream: { cliStdout: m.cliStdout, speechContent: m.content } },
      toolEvents: m.toolEvents?.map((t) => ({
        id: t.id,
        type: 'tool_result' as const,
        label: t.name,
        detail: t.output,
        inputDetail: t.input,
        status: t.status,
        timestamp: m.timestamp,
      })),
    }));

    return messages;
  }, [events, current, typingMs]);
  const chapters = useMemo(() => extractChapters(read.events), [read.events]);
  const features = useMemo(
    () => featureItems.map((item) => ({ id: item.id, featureId: extractFeatureId(item.tags), title: item.title })),
    [featureItems],
  );
  const rawData = useMemo(
    () => ({
      ...read,
      thread,
      source,
      storyId,
      annotations,
      guideLanguage,
      guideScript,
      guideHtml,
      guideTeam,
      messages,
      chapters,
      features,
    }),
    [
      read,
      thread,
      source,
      storyId,
      annotations,
      guideLanguage,
      guideScript,
      guideHtml,
      guideTeam,
      messages,
      chapters,
      features,
    ],
  );
  return {
    action,
    data: rawData,
  };
}
