import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CollectiveEventEnvelope, CollectiveParticipant } from '../client-types.js';
import { firstEntryBeatMs, firstEntryBrowseKey, firstEntryKeys, firstEntryPhase } from './first-entry-model.js';

interface Input {
  readonly embedded: boolean;
  readonly ready: boolean;
  readonly serviceInstanceId?: string;
  readonly collectiveId?: string;
  readonly humanId?: string;
  readonly paired: boolean;
  readonly connectionId?: string;
  readonly publishedCatCount?: number;
  readonly participants?: readonly CollectiveParticipant[];
  readonly events: readonly CollectiveEventEnvelope[];
}

function stored(key: string | undefined): string | null {
  if (!key || typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string | undefined, value: string): void {
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Keep the current in-memory journey usable when storage is unavailable.
  }
}

function hasRealFirstReply(
  events: readonly CollectiveEventEnvelope[],
  baseline: number,
  humanId: string,
  connectionId: string,
): boolean {
  const requests = events.flatMap((event) => {
    const recipient = event.recipient;
    return event.sequence > baseline &&
      event.actor.kind === 'human' &&
      event.actor.humanId === humanId &&
      recipient?.kind === 'agent' &&
      recipient.connectionId === connectionId &&
      event.location?.channelId === 'general'
      ? [{ event, agentId: recipient.agentId }]
      : [];
  });
  return requests.some(({ event: request, agentId }) =>
    events.some(
      (reply) =>
        reply.replyToEventId === request.eventId &&
        reply.sequence > request.sequence &&
        reply.actor.kind === 'agent' &&
        reply.actor.provenance.connectionId === connectionId &&
        reply.actor.provenance.catId === agentId,
    ),
  );
}

export function useFirstEntryGuide(input: Input) {
  const [, setRevision] = useState(0);
  const ephemeral = useRef(new Map<string, string>());
  const [beat, setBeat] = useState(0);
  const [arrivalComplete, setArrivalComplete] = useState(false);
  const [replayKey, setReplayKey] = useState<string>();
  const [handoffKey, setHandoffKey] = useState<string>();
  const [handoffCaptionVisible, setHandoffCaptionVisible] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const eventsRef = useRef(input.events);
  eventsRef.current = input.events;
  const { serviceInstanceId, collectiveId, humanId, connectionId } = input;
  const entryKey = useMemo(
    () => firstEntryBrowseKey({ serviceInstanceId, collectiveId, humanId }),
    [serviceInstanceId, collectiveId, humanId],
  );
  const pairStartedKey = entryKey ? `${entryKey}:pair-started` : undefined;
  const keys = useMemo(
    () => firstEntryKeys({ serviceInstanceId, collectiveId, humanId, connectionId }),
    [serviceInstanceId, collectiveId, humanId, connectionId],
  );
  const read = useCallback((key: string | undefined) => (key ? (ephemeral.current.get(key) ?? stored(key)) : null), []);
  const persist = useCallback((key: string | undefined, value: string) => {
    if (!key) return;
    ephemeral.current.set(key, value);
    write(key, value);
    setRevision((current) => current + 1);
  }, []);
  const ownCats = useMemo(
    () =>
      input.participants?.filter(
        (cat) =>
          cat.connectionId === input.connectionId &&
          cat.availability === 'declared' &&
          cat.channelIds.includes('general'),
      ) ?? [],
    [input.connectionId, input.participants],
  );
  const narrator = ownCats[0];
  const phase = firstEntryPhase({
    embedded: input.embedded,
    ready: input.ready && Boolean(entryKey),
    paired: input.paired && Boolean(keys),
    entryDismissed: read(entryKey) === 'yes',
    participantsLoaded: input.participants !== undefined,
    ownCatCount: ownCats.length,
    viewed: read(keys?.viewed) === 'yes',
    pairStarted: read(pairStartedKey) === 'yes',
    publishedCatCount: input.publishedCatCount,
    replaying: replayKey === keys?.viewed,
    handoff: handoffKey === keys?.viewed,
  });
  const browse = useCallback(() => persist(entryKey, 'yes'), [entryKey, persist]);
  const beginPair = useCallback(() => {
    persist(entryKey, 'yes');
    persist(pairStartedKey, 'yes');
  }, [entryKey, pairStartedKey, persist]);
  const finish = useCallback(() => {
    if (!keys) return;
    const wasReplay = replayKey === keys.viewed;
    persist(keys.viewed, 'yes');
    persist(pairStartedKey, 'no');
    if (read(keys.baseline) === null)
      persist(keys.baseline, String(eventsRef.current.reduce((max, event) => Math.max(max, event.sequence), 0)));
    setReplayKey(undefined);
    setHandoffKey(wasReplay ? undefined : keys.viewed);
    setHandoffCaptionVisible(!wasReplay);
    setArrivalComplete(true);
  }, [keys, pairStartedKey, persist, read, replayKey]);
  const next = useCallback(() => {
    setArrivalComplete(true);
    if (beat === 3) finish();
    else setBeat((current) => current + 1);
  }, [beat, finish]);
  const replay = useCallback(() => {
    if (!keys || !narrator) return;
    setBeat(0);
    setArrivalComplete(false);
    setHandoffKey(undefined);
    setHandoffCaptionVisible(false);
    setReplayKey(keys.viewed);
  }, [keys, narrator]);
  useEffect(() => {
    if (phase !== 'playing') return;
    const timer = window.setTimeout(next, firstEntryBeatMs);
    return () => window.clearTimeout(timer);
  }, [next, phase]);
  useEffect(() => {
    if (phase !== 'playing' || beat !== 0) return;
    const timer = window.setTimeout(() => setArrivalComplete(true), 1_250);
    return () => window.clearTimeout(timer);
  }, [beat, phase]);
  useEffect(() => {
    if (!handoffCaptionVisible) return;
    const timer = window.setTimeout(() => setHandoffCaptionVisible(false), 1_200);
    return () => window.clearTimeout(timer);
  }, [handoffCaptionVisible]);
  useEffect(() => {
    if (!keys || !input.humanId || !input.connectionId || read(keys.hint) === 'yes' || read(keys.viewed) !== 'yes')
      return;
    const storedBaseline = read(keys.baseline);
    if (storedBaseline === null) return;
    const baseline = Number(storedBaseline);
    if (!Number.isSafeInteger(baseline) || baseline < 0) return;
    if (!hasRealFirstReply(input.events, baseline, input.humanId, input.connectionId)) return;
    persist(keys.hint, 'yes');
    setHintVisible(true);
  }, [input.events, input.humanId, input.connectionId, keys, persist, read]);
  return {
    phase,
    beat,
    arrivalComplete,
    ownCats,
    pairStarted: read(pairStartedKey) === 'yes',
    narrator,
    hintVisible,
    handoffCaptionVisible,
    browse,
    beginPair,
    next,
    finish,
    replay,
    markSent: () => {
      setHandoffKey(undefined);
      setHandoffCaptionVisible(false);
    },
    dismissHint: () => setHintVisible(false),
  };
}

export type FirstEntryGuide = ReturnType<typeof useFirstEntryGuide>;
