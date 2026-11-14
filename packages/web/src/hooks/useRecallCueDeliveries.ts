import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { type CueReadResult, cueReadBatches, readCueBatch } from './recall-cue-batch';
import { recallReplyInvocationId } from './recall-feed-model';
import type { RecallEvent } from './recall-types';

type Read = { id: string; token: string };
async function fillCueReads(
  threadId: string,
  reads: Read[],
  values: Map<string, CueReadResult>,
  generation: number,
  signal: AbortSignal,
) {
  const missing = reads.filter((read) => values.get(read.id)?.token !== read.token);
  for (const batch of cueReadBatches(missing)) {
    signal.throwIfAborted();
    try {
      const results = await readCueBatch(threadId, batch, generation, signal);
      signal.throwIfAborted();
      for (const [id, result] of results) values.set(id, result);
    } catch (error) {
      if (signal.aborted) throw error;
      for (const read of batch) values.set(read.id, { token: read.token, events: [], failed: true });
    }
  }
}
function collected(reads: Read[], values: Map<string, CueReadResult>) {
  return {
    events: reads.flatMap((read) => values.get(read.id)?.events ?? []),
    failed: reads.some((read) => values.get(read.id)?.failed),
    loading: false,
  };
}

export function useRecallCueDeliveries(input: {
  threadId: string | null;
  scope: string;
  generation: number;
  messages: readonly ChatMessage[];
  historyInvocations: string[];
}) {
  const { threadId, scope, generation, messages, historyInvocations } = input;
  const cache = useRef({ scope, values: new Map<string, CueReadResult>() });
  const [state, setState] = useState({ scope: '', events: [] as RecallEvent[], failed: false, loading: true });
  const byInvocation = new Map(
    messages.flatMap((message) => {
      const id = recallReplyInvocationId(message);
      return id ? [[id, message] as const] : [];
    }),
  );
  const readsKey = JSON.stringify(
    [...new Set([...historyInvocations, ...byInvocation.keys()])].sort().map((id) => {
      const message = byInvocation.get(id);
      return {
        id,
        token: `${generation}:${message ? `${message.isStreaming}:${message.toolEvents?.length ?? 0}` : 'history'}`,
      };
    }),
  );
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (cache.current.scope !== scope) cache.current = { scope, values: new Map() };
    const values = cache.current.values;
    const reads = JSON.parse(readsKey) as Array<{ id: string; token: string }>;
    setState((previous) => ({
      scope,
      events: previous.scope === scope ? previous.events : [],
      failed: false,
      loading: true,
    }));
    if (!threadId) setState({ scope, events: [], failed: false, loading: false });
    else
      void fillCueReads(threadId, reads, values, generation, controller.signal)
        .then(() => {
          if (active) setState({ scope, ...collected(reads, values) });
        })
        .catch(() => {
          if (active) setState({ scope, events: [], failed: true, loading: false });
        });
    return () => {
      active = false;
      controller.abort();
    };
  }, [threadId, scope, generation, readsKey]);
  return state.scope === scope ? state : { scope, events: [], failed: false, loading: !!threadId };
}
