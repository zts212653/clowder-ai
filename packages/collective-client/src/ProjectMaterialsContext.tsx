import type { CollectiveMaterialPublication } from '@cat-cafe/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { MaterialFeed, ProjectMaterialClient } from './project-material-client.js';
import type { RoadmapViewState } from './roadmap-view-model.js';

const empty: MaterialFeed = { items: [], pendingCount: 0, unavailable: [] };
const context = createContext<{
  client?: ProjectMaterialClient;
  openSource?: (publication: CollectiveMaterialPublication, view: RoadmapViewState) => void;
}>({});
export function ProjectMaterialsProvider({
  client,
  onOpenSource,
  children,
}: {
  client?: ProjectMaterialClient;
  onOpenSource?: (publication: CollectiveMaterialPublication, view: RoadmapViewState) => void;
  children: ReactNode;
}) {
  return <context.Provider value={{ client, openSource: onOpenSource }}>{children}</context.Provider>;
}

/** A live authorized view, never a saved source-content cache. Failures clear the previous metadata. */
export function useProjectMaterials(roadmapId: string) {
  const { client, openSource } = useContext(context),
    current = useRef(client);
  current.current = client;
  const epoch = `${client?.namespace ?? ''}:${roadmapId}`,
    epochRef = useRef(epoch),
    sequence = useRef(0);
  epochRef.current = epoch;
  const [state, setState] = useState({ epoch, feed: empty, loading: false, error: false });
  const reload = useCallback(async () => {
    const port = current.current,
      generation = ++sequence.current;
    if (!port) return;
    setState({ epoch, feed: empty, loading: true, error: false });
    try {
      const feed = await port.list(roadmapId);
      if (epochRef.current === epoch && generation === sequence.current)
        setState({ epoch, feed, loading: false, error: false });
    } catch {
      if (epochRef.current === epoch && generation === sequence.current)
        setState({ epoch, feed: empty, loading: false, error: true });
    }
  }, [epoch, roadmapId]);
  useEffect(() => {
    void reload();
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void reload();
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('collective:material-changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      sequence.current += 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('collective:material-changed', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload]);
  return {
    ...(state.epoch === epoch ? state : { epoch, feed: empty, loading: true, error: false }),
    client,
    openSource,
    reload,
  };
}
