import type { CollectiveHostContextInit } from '@cat-cafe/shared';
import { type MutableRefObject, useEffect } from 'react';

/** Reports public rectangles, never asks the frame to read or mutate private Host data. */
export function useHostUiPlacement(
  origin: string | null,
  active: MutableRefObject<{
    bridge?: CollectiveHostContextInit;
    contextId: string;
    revision: number;
  }>,
  channelId: string,
  generation: string,
) {
  useEffect(() => {
    if (!origin) return;
    let frame = 0;
    const publish = () => {
      frame = 0;
      const context = active.current;
      if (!context.bridge || context.revision < 1) return;
      const membersOpen = Boolean(document.querySelector('.members-page'));
      const slots = Array.from(document.querySelectorAll<HTMLElement>('[data-host-ui-slot]'))
        .flatMap((element) => {
          if (membersOpen && element.dataset.hostUiSlot !== 'roster') return [];
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight || element.closest('[hidden]'))
            return [];
          return [
            {
              kind: element.dataset.hostUiSlot,
              eventId: element.dataset.sourceEventId,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          ];
        })
        .slice(0, 100);
      window.parent.postMessage(
        {
          type: 'collective:client-ui-placement',
          bridgeId: context.bridge.bridgeId,
          contextId: context.contextId,
          contextRevision: context.revision,
          serviceInstanceId: context.bridge.serviceInstanceId,
          collectiveId: context.bridge.collectiveId,
          humanId: context.bridge.humanId,
          channelId,
          slots,
        },
        origin,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(publish);
    };
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.getElementById('collective-root') ?? document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    const size = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    size?.observe(document.body);
    addEventListener('scroll', schedule, true);
    addEventListener('resize', schedule);
    // A heartbeat recovers a layout message that arrived before the Host applied a new context revision.
    const timer = setInterval(schedule, 1000);
    schedule();
    return () => {
      mutation.disconnect();
      size?.disconnect();
      clearInterval(timer);
      cancelAnimationFrame(frame);
      removeEventListener('scroll', schedule, true);
      removeEventListener('resize', schedule);
    };
  }, [origin, active, channelId, generation]);
}
