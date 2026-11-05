import {
  type CollectiveHostContextInit,
  type CollectiveHostProjectWorkFocus,
  collectiveClientAccountabilityChangedSchema,
  collectiveHostProjectWorkFocusSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef } from 'react';
import type { ClientSnapshot } from './client-types.js';
import {
  COLLECTIVE_ACCOUNTABILITY_CHANGED_EVENT,
  type CollectiveAccountabilityChangedDetail,
} from './collective-accountability-events.js';

type HostContextGeneration = {
  bridge?: CollectiveHostContextInit;
  contextId: string;
  revision: number;
};

type ProjectWorkFocus = {
  workId: string;
  channelId: string;
  roadmapId: string;
  accountabilityRequestId: string;
};

export function useHostAccountabilityContext(input: {
  hostOrigin: string | null;
  context: { current: HostContextGeneration };
  works: NonNullable<ClientSnapshot['collaboration']>['works'] | undefined;
  roadmaps: NonNullable<ClientSnapshot['collaboration']>['roadmaps'] | undefined;
  onFocus: (focus: ProjectWorkFocus) => void;
}) {
  const currentWorks = useRef(input.works);
  currentWorks.current = input.works;
  const currentRoadmaps = useRef(input.roadmaps);
  currentRoadmaps.current = input.roadmaps;
  const pendingFocus = useRef<CollectiveHostProjectWorkFocus>();
  const pendingChange = useRef<CollectiveAccountabilityChangedDetail>();

  const applyFocus = useCallback(
    (value: CollectiveHostProjectWorkFocus) => {
      if (!generationMatches(value, input.context.current)) return false;
      const activeHumanId = input.context.current.bridge?.humanId;
      const work = currentWorks.current?.find(
        (candidate) =>
          candidate.workId === value.workId &&
          candidate.revision === value.workRevision &&
          candidate.lifecycle === 'committed' &&
          !candidate.assignment &&
          candidate.sourceLocation.channelId === value.channelId &&
          candidate.accountabilityRequests?.some(
            (request) =>
              request.accountabilityRequestId === value.accountabilityRequestId &&
              request.roadmapId === value.roadmapId &&
              request.targetHumanId === activeHumanId &&
              request.status === 'pending',
          ),
      );
      const roadmap = currentRoadmaps.current?.find(
        (candidate) =>
          candidate.roadmapId === value.roadmapId &&
          candidate.status === 'active' &&
          candidate.workIds.includes(value.workId),
      );
      if (!work || !roadmap) return false;
      input.onFocus({
        workId: work.workId,
        channelId: value.channelId,
        roadmapId: roadmap.roadmapId,
        accountabilityRequestId: value.accountabilityRequestId,
      });
      return true;
    },
    [input.context, input.onFocus],
  );

  const postChange = useCallback(
    (detail: CollectiveAccountabilityChangedDetail) => {
      const active = input.context.current;
      const activeBridge = active.bridge;
      const work = currentWorks.current?.find(
        (candidate) =>
          candidate.workId === detail.workId &&
          candidate.revision === detail.workRevision &&
          candidate.accountabilityRequests?.some(
            (request) =>
              request.accountabilityRequestId === detail.accountabilityRequestId &&
              request.targetHumanId === activeBridge?.humanId &&
              request.status === detail.status,
          ),
      );
      if (!work || !activeBridge || !input.hostOrigin || active.revision < 1) return false;
      const message = collectiveClientAccountabilityChangedSchema.safeParse({
        type: 'collective:client-accountability-changed',
        bridgeId: activeBridge.bridgeId,
        contextId: active.contextId,
        contextRevision: active.revision,
        serviceInstanceId: activeBridge.serviceInstanceId,
        collectiveId: activeBridge.collectiveId,
        connectionId: activeBridge.connectionId,
        humanId: activeBridge.humanId,
        ...detail,
      });
      if (!message.success) return false;
      window.parent.postMessage(message.data, input.hostOrigin);
      return true;
    },
    [input.context, input.hostOrigin],
  );

  const handleFocus = useCallback(
    (data: unknown) => {
      const parsed = collectiveHostProjectWorkFocusSchema.safeParse(data);
      if (!parsed.success) return false;
      const value = parsed.data;
      if (!generationMatches(value, input.context.current)) return true;
      pendingFocus.current = value;
      if (applyFocus(value)) pendingFocus.current = undefined;
      return true;
    },
    [applyFocus, input.context],
  );

  const reset = useCallback(() => {
    pendingFocus.current = undefined;
    pendingChange.current = undefined;
  }, []);

  useEffect(() => {
    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<CollectiveAccountabilityChangedDetail>).detail;
      if (!detail) return;
      pendingChange.current = detail;
      if (postChange(detail)) pendingChange.current = undefined;
    };
    window.addEventListener(COLLECTIVE_ACCOUNTABILITY_CHANGED_EVENT, handleChange);
    return () => window.removeEventListener(COLLECTIVE_ACCOUNTABILITY_CHANGED_EVENT, handleChange);
  }, [postChange]);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || !input.works || !input.roadmaps) return;
    if (!generationMatches(pending, input.context.current)) {
      pendingFocus.current = undefined;
      return;
    }
    if (applyFocus(pending)) pendingFocus.current = undefined;
  }, [applyFocus, input.context, input.roadmaps, input.works]);

  useEffect(() => {
    if (!input.works) return;
    const pending = pendingChange.current;
    if (pending && postChange(pending)) pendingChange.current = undefined;
  }, [input.works, postChange]);

  return { handleFocus, reset };
}

function generationMatches(
  value: { bridgeId: string; contextId: string; contextRevision: number },
  active: HostContextGeneration,
) {
  return (
    value.bridgeId === active.bridge?.bridgeId &&
    value.contextId === active.contextId &&
    value.contextRevision === active.revision
  );
}
