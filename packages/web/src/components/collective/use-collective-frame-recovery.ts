'use client';

import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef } from 'react';

import type { ObservedFrameGeneration } from './use-collective-world-directory';

export function useCollectiveFrameRecovery(input: {
  readonly iframeRef: RefObject<HTMLIFrameElement | null>;
  readonly frameGeneration?: ObservedFrameGeneration;
  readonly remoteState?: string;
  readonly remoteServiceInstanceId?: string;
  readonly setFrameAttempt: Dispatch<SetStateAction<number>>;
}) {
  const handshakenFrame = useRef<Window>();
  useEffect(() => {
    const contentWindow = input.iframeRef.current?.contentWindow;
    if (input.frameGeneration?.serviceInstanceId && contentWindow) handshakenFrame.current = contentWindow;
  }, [input.frameGeneration, input.iframeRef]);

  const previousRemoteState = useRef(input.remoteState);
  useEffect(() => {
    const sameFrameWindow = Boolean(
      input.iframeRef.current?.contentWindow && input.iframeRef.current.contentWindow === handshakenFrame.current,
    );
    const frameServiceInstanceId = input.frameGeneration?.serviceInstanceId;
    const sameInstance = Boolean(sameFrameWindow && input.remoteServiceInstanceId === frameServiceInstanceId);
    const changedInstance = Boolean(
      input.remoteState &&
        input.remoteState !== 'offline' &&
        sameFrameWindow &&
        input.remoteServiceInstanceId &&
        input.remoteServiceInstanceId !== frameServiceInstanceId,
    );
    const recoveredWithoutVerifiedFrame = Boolean(
      previousRemoteState.current === 'offline' &&
        input.remoteState &&
        input.remoteState !== 'offline' &&
        !sameInstance,
    );
    if (changedInstance || recoveredWithoutVerifiedFrame) input.setFrameAttempt((attempt) => attempt + 1);
    previousRemoteState.current = input.remoteState;
  }, [
    input.frameGeneration?.serviceInstanceId,
    input.iframeRef,
    input.remoteServiceInstanceId,
    input.remoteState,
    input.setFrameAttempt,
  ]);
}
