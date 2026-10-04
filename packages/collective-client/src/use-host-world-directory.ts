import { collectiveWorldDirectoryReadySchema } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ClientSnapshot } from './client-types.js';
import { observeHostAppearanceGeneration } from './host-appearance.js';
import {
  projectWorldDirectory,
  type ReadyWorldDirectory,
  trustedWorldDirectoryHostMessage,
  worldSelectionMatches,
} from './world-directory-bridge.js';

export function useHostWorldDirectory(input: {
  readonly embedded: boolean;
  readonly snapshot: ClientSnapshot;
  readonly selectCollective: (collectiveId: string) => void;
}) {
  const hostOrigin = resolveHostOrigin(input.embedded);
  const authorityKey = `${input.snapshot.meta?.serviceInstanceId ?? 'unknown'}:${input.snapshot.me?.human.humanId ?? 'anonymous'}`;
  const projectionSource = useMemo(
    () => ({
      phase: input.snapshot.phase,
      meta: input.snapshot.meta,
      me: input.snapshot.me,
      collective: input.snapshot.collective,
      connection: input.snapshot.connection,
    }),
    [
      input.snapshot.collective,
      input.snapshot.connection,
      input.snapshot.me,
      input.snapshot.meta,
      input.snapshot.phase,
    ],
  );
  const [bridge, setBridge] = useState<{ readonly bridgeId: string; readonly authorityKey: string }>();
  const revision = useRef(0);
  const current = useRef<ReadyWorldDirectory>();
  const selectCollective = useRef(input.selectCollective);
  selectCollective.current = input.selectCollective;

  useEffect(() => {
    if (!hostOrigin || window.parent === window) return;
    const parent = window.parent;
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = trustedWorldDirectoryHostMessage(event, hostOrigin, parent);
      if (!message) return;
      if (message.type === 'collective:host-world-directory-init') {
        revision.current = 0;
        current.current = undefined;
        // The appearance bridge is fenced to this frame generation (read-only observation; the handshake is unchanged).
        observeHostAppearanceGeneration(message.bridgeId);
        setBridge({ bridgeId: message.bridgeId, authorityKey });
        return;
      }
      const directory = current.current;
      if (directory && worldSelectionMatches(message, directory)) {
        selectCollective.current(message.collectiveId);
      }
    };
    window.addEventListener('message', onMessage);
    parent.postMessage(
      collectiveWorldDirectoryReadySchema.parse({ type: 'collective:world-directory-ready' }),
      hostOrigin,
    );
    return () => {
      current.current = undefined;
      window.removeEventListener('message', onMessage);
    };
  }, [authorityKey, hostOrigin]);

  useEffect(() => {
    if (!bridge || bridge.authorityKey !== authorityKey || !hostOrigin || window.parent === window) return;
    const projection = projectWorldDirectory(projectionSource, bridge.bridgeId, revision.current + 1);
    if (!projection) return;
    revision.current = projection.revision;
    current.current = projection.state === 'ready' ? projection : undefined;
    window.parent.postMessage(projection, hostOrigin);
  }, [authorityKey, bridge, hostOrigin, projectionSource]);
}

function resolveHostOrigin(embedded: boolean): string | undefined {
  if (!embedded || typeof window === 'undefined') return undefined;
  const candidate = new URLSearchParams(window.location.search).get('hostOrigin');
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === candidate ? candidate : undefined;
  } catch {
    return undefined;
  }
}
