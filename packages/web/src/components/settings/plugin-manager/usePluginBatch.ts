'use client';

import { useEffect, useRef, useState } from 'react';
import type { PluginBatchEntry, PluginBatchResult } from './plugin-batch-model';
import { runPluginBatch } from './plugin-batch-runner';

export function usePluginBatch(onChanged?: () => void | Promise<void>) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'confirm' | 'running' | 'results'>('confirm');
  const [results, setResults] = useState<PluginBatchResult[]>([]);
  const lifetime = useRef({ mounted: true });
  const run = useRef<{ cancelled: boolean } | null>(null);
  const running = useRef(false);
  const stop = () => {
    if (run.current) run.current.cancelled = true;
  };
  useEffect(() => {
    const owner = { mounted: true };
    lifetime.current = owner;
    const leave = () => {
      if (run.current) run.current.cancelled = true;
    };
    window.addEventListener('pagehide', leave);
    return () => {
      owner.mounted = false;
      leave();
      window.removeEventListener('pagehide', leave);
    };
  }, []);
  return {
    open,
    phase,
    results,
    show: () => {
      if (running.current) return;
      setResults([]);
      setPhase('confirm');
      setOpen(true);
    },
    close: () => {
      stop();
      setOpen(false);
    },
    stop,
    start: async (entries: readonly PluginBatchEntry[]) => {
      if (running.current || entries.length === 0) return;
      const owner = lifetime.current;
      const token = { cancelled: false };
      run.current = token;
      running.current = true;
      const active = () => owner.mounted && !token.cancelled;
      setPhase('running');
      setResults(entries.map((e) => ({ id: e.plugin.id, state: 'queued' })));
      try {
        await runPluginBatch(entries, {
          active,
          onResult: (result) => {
            if (owner.mounted) setResults((current) => current.map((r) => (r.id === result.id ? result : r)));
          },
          onChanged: async () => {
            if (owner.mounted) await onChanged?.();
          },
        });
      } finally {
        running.current = false;
        if (owner.mounted) {
          setResults((current) => current.map((r) => (r.state === 'queued' ? { ...r, state: 'skipped' } : r)));
          setPhase('results');
          await onChanged?.();
        }
      }
    },
  };
}
export type PluginBatchController = ReturnType<typeof usePluginBatch>;
