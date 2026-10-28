import {
  type CollectiveCafeSection,
  type CollectiveHostContextInit,
  type CollectiveHostParticipationReady,
  type CollectiveHostWorkFocus,
  collectiveHostContextActionSchema,
  collectiveHostContextInitSchema,
  collectiveHostParticipationReadySchema,
  collectiveHostWorkFocusSchema,
  collectiveHostWorkResultReconciledSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientRequest } from './client-request.js';
import type { ClientSnapshot } from './client-types.js';
import type { collectiveArtifactClient } from './collective-artifact-client.js';
import { useHostAccountabilityContext } from './use-host-accountability-context.js';
import { useHostDocumentSurface } from './use-host-document-surface.js';
import { useHostMediaShare } from './use-host-media-share.js';
import { type MediaSelection, useHostMediaSurface } from './use-host-media-surface.js';
import { type ProjectAttentionFocus, useHostProjectAttentionContext } from './use-host-project-attention-context.js';
import { useHostUiPlacement } from './use-host-ui-placement.js';
import { useHostWorkPolicy } from './use-host-work-policy.js';

export function useHostContext(
  embedded: boolean,
  snapshot: ClientSnapshot,
  channelId: string,
  channelIds: readonly string[],
  humanSession?: { request: ClientRequest; refresh: () => Promise<void> },
  media?: {
    selection?: MediaSelection;
    api?: ReturnType<typeof collectiveArtifactClient>;
    onShared?: Parameters<typeof useHostMediaShare>[0]['onShared'];
    humanName?: (humanId: string) => string;
    onDocumentReturn?: Parameters<typeof useHostDocumentSurface>[0]['onDocumentReturn'];
  },
  onOpenMembers?: () => void,
) {
  const openMembersAction = useRef(onOpenMembers);
  openMembersAction.current = onOpenMembers;
  const [bridge, setBridge] = useState<CollectiveHostContextInit>();
  const liveBridge = useRef<CollectiveHostContextInit>();
  const [participationReady, setParticipationReady] = useState<CollectiveHostParticipationReady>();
  const [open, setOpen] = useState(false);
  const [cafeSection, setCafeSection] = useState<CollectiveCafeSection>('cats');
  const [focusWork, setFocusWork] = useState<
    | ProjectAttentionFocus
    | { workId: string; channelId: string; eventId: string }
    | { workId: string; channelId: string; roadmapId: string; accountabilityRequestId: string }
  >();
  const [contextId] = useState(() => crypto.randomUUID());
  const revision = useRef(0);
  const opener = useRef<HTMLElement>();
  const reconciledWorks = useRef(new Set<string>());
  const pendingWorkFocus = useRef<CollectiveHostWorkFocus>();
  const hostOrigin = embedded ? new URLSearchParams(location.search).get('hostOrigin') : null;
  const publicContext = useRef({ bridge, contextId, revision: 0 });
  const requestWorkPermission = useHostWorkPolicy({ hostOrigin, context: publicContext, ...humanSession });
  const currentWorks = useRef(snapshot.collaboration?.works);
  currentWorks.current = snapshot.collaboration?.works;
  const serviceInstanceId = snapshot.meta?.serviceInstanceId;
  const collectiveId = snapshot.collective?.collectiveId;
  const humanId = snapshot.me?.human.humanId;
  const projectionReady =
    snapshot.participants !== undefined && snapshot.members !== undefined && snapshot.collaboration !== undefined;
  const applyWorkFocus = useCallback((value: CollectiveHostWorkFocus) => {
    if (!reconciliationMatches(value, publicContext.current)) return false;
    const work = currentWorks.current?.find(
      (candidate) =>
        candidate.workId === value.workId &&
        candidate.revision === value.workRevision &&
        candidate.lifecycle === 'result_ready' &&
        candidate.status === 'result_ready' &&
        candidate.sourceLocation.channelId === value.channelId &&
        candidate.resultEventId === value.resultEventId &&
        (candidate.resultRevision ?? 1) === value.resultRevision &&
        candidate.assignment?.connectionId === publicContext.current.bridge?.connectionId,
    );
    if (!work) return false;
    setFocusWork({ workId: work.workId, channelId: value.channelId, eventId: value.resultEventId });
    return true;
  }, []);
  const projectAttentionContext = useHostProjectAttentionContext({
    context: publicContext,
    snapshot,
    onFocus: setFocusWork,
  });
  const { handleFocus: handleAccountabilityFocus, reset: resetAccountabilityContext } = useHostAccountabilityContext({
    hostOrigin,
    context: publicContext,
    works: snapshot.collaboration?.works,
    roadmaps: snapshot.collaboration?.roadmaps,
    onFocus: setFocusWork,
  });
  useEffect(() => {
    if (!hostOrigin || !serviceInstanceId || !collectiveId || !humanId) return;
    const handleInit = (data: unknown) => {
      const parsed = collectiveHostContextInitSchema.safeParse(data);
      if (!parsed.success) return false;
      setOpen(false);
      setCafeSection('cats');
      setFocusWork(undefined);
      pendingWorkFocus.current = undefined;
      resetAccountabilityContext();
      projectAttentionContext.reset();
      reconciledWorks.current.clear();
      setParticipationReady(undefined);
      const matched = hostInitMatches(parsed.data, serviceInstanceId, collectiveId, humanId) ? parsed.data : undefined;
      liveBridge.current = matched;
      setBridge(matched);
      return true;
    };
    const handleParticipationReady = (data: unknown) => {
      const parsed = collectiveHostParticipationReadySchema.safeParse(data);
      if (!parsed.success) return false;
      const value = parsed.data;
      const active = liveBridge.current;
      if (
        active?.bridgeId === value.bridgeId &&
        active.connectionId === value.connectionId &&
        active.authorityStatus !== 'revoked' &&
        value.serviceInstanceId === serviceInstanceId &&
        value.collectiveId === collectiveId &&
        value.humanId === humanId
      ) {
        setParticipationReady((current) =>
          current?.bridgeId === value.bridgeId && current.participationRevision >= value.participationRevision
            ? current
            : value,
        );
      }
      return true;
    };
    const handleReconciled = (data: unknown) => {
      const parsed = collectiveHostWorkResultReconciledSchema.safeParse(data);
      if (!parsed.success || !reconciliationMatches(parsed.data, publicContext.current)) return false;
      reconciledWorks.current.add(workRevisionKey(parsed.data));
      return true;
    };
    const handleAction = (data: unknown) => {
      const parsed = collectiveHostContextActionSchema.safeParse(data);
      if (!parsed.success || !actionMatches(parsed.data, publicContext.current)) return;
      if (parsed.data.type === 'collective:host-member-list-open') {
        setOpen(false);
        openMembersAction.current?.();
        return;
      }
      setOpen(parsed.data.type === 'collective:host-context-open');
      if (parsed.data.type === 'collective:host-context-close') opener.current?.focus();
    };
    const handleWorkFocus = (data: unknown) => {
      const parsed = collectiveHostWorkFocusSchema.safeParse(data);
      if (!parsed.success) return false;
      const value = parsed.data;
      if (!reconciliationMatches(value, publicContext.current)) return true;
      pendingWorkFocus.current = value;
      if (applyWorkFocus(value)) pendingWorkFocus.current = undefined;
      return true;
    };
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== hostOrigin) return;
      if (
        handleInit(event.data) ||
        handleParticipationReady(event.data) ||
        handleReconciled(event.data) ||
        handleWorkFocus(event.data) ||
        handleAccountabilityFocus(event.data) ||
        projectAttentionContext.handleFocus(event.data)
      )
        return;
      handleAction(event.data);
    };
    window.addEventListener('message', listener);
    window.parent.postMessage({ type: 'collective:context-ready' }, hostOrigin);
    return () => window.removeEventListener('message', listener);
  }, [
    applyWorkFocus,
    collectiveId,
    hostOrigin,
    humanId,
    handleAccountabilityFocus,
    projectAttentionContext.handleFocus,
    projectAttentionContext.reset,
    resetAccountabilityContext,
    serviceInstanceId,
  ]);
  useEffect(() => {
    const pending = pendingWorkFocus.current;
    if (!pending || !snapshot.collaboration?.works) return;
    if (!reconciliationMatches(pending, publicContext.current)) {
      pendingWorkFocus.current = undefined;
      return;
    }
    if (applyWorkFocus(pending)) pendingWorkFocus.current = undefined;
  }, [applyWorkFocus, snapshot.collaboration?.works]);
  const channelKey = JSON.stringify([...new Set([channelId, ...channelIds])].slice(0, 100));
  useEffect(() => {
    if (!bridge || !hostOrigin || !projectionReady) return;
    const nextRevision = ++revision.current;
    publicContext.current = { bridge, contextId, revision: nextRevision };
    window.parent.postMessage(
      {
        type: 'collective:client-context',
        bridgeId: bridge.bridgeId,
        contextId,
        revision: nextRevision,
        serviceInstanceId: bridge.serviceInstanceId,
        collectiveId: bridge.collectiveId,
        humanId: bridge.humanId,
        channelId,
        channelIds: JSON.parse(channelKey),
        openCafe: open,
      },
      hostOrigin,
    );
    window.parent.postMessage(
      {
        type: 'collective:client-cafe-section',
        bridgeId: bridge.bridgeId,
        contextId,
        contextRevision: nextRevision,
        serviceInstanceId: bridge.serviceInstanceId,
        collectiveId: bridge.collectiveId,
        humanId: bridge.humanId,
        channelId,
        section: cafeSection,
      },
      hostOrigin,
    );
  }, [bridge, hostOrigin, contextId, channelId, channelKey, open, cafeSection, projectionReady]);
  useHostUiPlacement(
    hostOrigin,
    publicContext,
    channelId,
    JSON.stringify([bridge, channelKey, open, cafeSection, projectionReady]),
  );
  const completedWorks = useMemo(
    () =>
      (snapshot.collaboration?.works ?? []).filter(
        (work) =>
          work.lifecycle === 'completed' &&
          work.status === 'completed' &&
          work.assignment?.connectionId === bridge?.connectionId &&
          work.assignmentEventId !== undefined &&
          work.resultEventId !== undefined,
      ),
    [bridge?.connectionId, snapshot.collaboration?.works],
  );
  const shareMedia = useHostMediaShare({
    context: publicContext,
    bridge,
    hostOrigin,
    channelId,
    onShared: media?.onShared,
  });
  const documentSurfaceReady = useHostDocumentSurface({
    context: publicContext,
    bridge,
    hostOrigin,
    generation: JSON.stringify([bridge, channelKey, open, cafeSection, projectionReady]),
    ...media,
  });
  useHostMediaSurface({
    context: publicContext,
    bridge,
    hostOrigin,
    channelId,
    generation: JSON.stringify([bridge, channelKey, open, cafeSection, projectionReady]),
    // This adapter's acknowledgement also negotiates project-aware media return coordinates.
    projectReturnSupported: documentSurfaceReady,
    ...media,
  });
  useEffect(() => {
    if (!bridge || !hostOrigin || completedWorks.length === 0) return;
    const postPending = () => {
      const active = publicContext.current;
      if (active.bridge?.bridgeId !== bridge.bridgeId || active.revision < 1) return;
      for (const work of completedWorks) {
        if (reconciledWorks.current.has(workRevisionKey(work))) continue;
        window.parent.postMessage(
          {
            type: 'collective:client-work-result-accepted',
            bridgeId: bridge.bridgeId,
            contextId: active.contextId,
            contextRevision: active.revision,
            serviceInstanceId: bridge.serviceInstanceId,
            collectiveId: bridge.collectiveId,
            connectionId: bridge.connectionId,
            humanId: bridge.humanId,
            workId: work.workId,
            workRevision: work.revision,
            assignmentEventId: work.assignmentEventId,
            resultEventId: work.resultEventId,
            resultRevision: work.resultRevision ?? 1,
          },
          hostOrigin,
        );
      }
    };
    postPending();
    const retry = window.setInterval(postPending, 5_000);
    return () => window.clearInterval(retry);
  }, [bridge, completedWorks, hostOrigin]);
  const show = useCallback((section: CollectiveCafeSection = 'cats') => {
    if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
    setCafeSection(section);
    setOpen(true);
  }, []);
  const hide = useCallback(() => setOpen(false), []);
  return {
    documentSurfaceReady,
    shareMedia: bridge && bridge.authorityStatus !== 'revoked' ? shareMedia : undefined,
    requestWorkPermission: humanSession ? requestWorkPermission : undefined,
    available: Boolean(bridge),
    paired: Boolean(bridge && bridge.authorityStatus !== 'revoked'),
    connectionId: bridge?.connectionId,
    participationReady: participationReady?.bridgeId === bridge?.bridgeId ? participationReady : undefined,
    open,
    cafeSection,
    show,
    hide,
    focusWork,
  };
}

function hostInitMatches(
  value: CollectiveHostContextInit,
  serviceInstanceId: string,
  collectiveId: string,
  humanId: string,
) {
  return (
    value.serviceInstanceId === serviceInstanceId && value.collectiveId === collectiveId && value.humanId === humanId
  );
}

function reconciliationMatches(
  value: { bridgeId: string; contextId: string; contextRevision: number },
  active: { bridge?: CollectiveHostContextInit; contextId: string; revision: number },
) {
  return (
    value.bridgeId === active.bridge?.bridgeId &&
    value.contextId === active.contextId &&
    value.contextRevision === active.revision
  );
}

function actionMatches(
  value: { bridgeId: string; contextId: string; revision: number },
  active: { bridge?: CollectiveHostContextInit; contextId: string; revision: number },
) {
  return (
    value.bridgeId === active.bridge?.bridgeId &&
    value.contextId === active.contextId &&
    value.revision === active.revision
  );
}

function workRevisionKey(value: { workId: string } & ({ workRevision: number } | { revision: number })) {
  return `${value.workId}:${'workRevision' in value ? value.workRevision : value.revision}`;
}
