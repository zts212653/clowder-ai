import { type RefObject, useLayoutEffect, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import {
  type PianoGeometry,
  type PianoRowMeasurement,
  projectPianoGeometry,
  scrollPianoGeometry,
} from './piano-geometry';

function measureRows(viewport: HTMLElement, ids: ReadonlySet<string>): PianoRowMeasurement[] {
  const viewportTop = viewport.getBoundingClientRect().top;
  return [...viewport.querySelectorAll<HTMLElement>('[data-message-viewport-id]')].flatMap((row) => {
    const id = row.dataset.messageViewportId;
    if (!id || !ids.has(id) || row.closest('[data-chat-container]') !== viewport) return [];
    const source = row.querySelector<HTMLElement>('[data-message-id]');
    if (
      source?.dataset.messageId === id &&
      source.getAttribute('aria-hidden') === 'true' &&
      source.classList.contains('h-0')
    )
      return [];
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) return [];
    const top = rect.top - viewportTop + viewport.scrollTop;
    return [
      {
        id,
        top,
        bottom: top + rect.height,
        error: row.dataset.messageNavigationError === 'true',
        awaitingResponse: !!row.querySelector('[data-message-navigation-response="interactive"]'),
      },
    ];
  });
}

export function usePianoGeometry(
  viewportRef: RefObject<HTMLElement | null>,
  trackRef: RefObject<HTMLDivElement | null>,
  messages: readonly ChatMessage[],
  observerKey?: string,
): PianoGeometry | null {
  const [measurement, setMeasurement] = useState<{
    ownerKey: string | undefined;
    ids: string;
    geometry: PianoGeometry | null;
  } | null>(null);
  const messageIds = JSON.stringify(messages.map((message) => message.id));
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;
    let active = true;
    let frame: number | null = null;
    let layoutChanged = true;
    let geometry: PianoGeometry | null = null;
    const ids = new Set(JSON.parse(messageIds) as string[]);
    const measure = () => {
      frame = null;
      if (!active) return;
      const contentHeight = viewport.scrollHeight;
      const viewportHeight = viewport.clientHeight;
      geometry =
        layoutChanged ||
        !geometry ||
        geometry.contentHeight !== contentHeight ||
        geometry.viewportHeight !== viewportHeight
          ? projectPianoGeometry(
              measureRows(viewport, ids),
              contentHeight,
              viewportHeight,
              viewport.scrollTop,
              track.getBoundingClientRect().height,
            )
          : scrollPianoGeometry(geometry, viewport.scrollTop);
      layoutChanged = false;
      const next = geometry;
      setMeasurement((previous) =>
        previous !== null &&
        previous.ownerKey === observerKey &&
        previous.ids === messageIds &&
        previous.geometry === next
          ? previous
          : { ownerKey: observerKey, ids: messageIds, geometry: next },
      );
    };
    const schedule = () => {
      if (active && frame === null) frame = requestAnimationFrame(measure);
    };
    const scheduleLayout = () => {
      layoutChanged = true;
      schedule();
    };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleLayout);
    const observeRows = () => {
      resize?.disconnect();
      resize?.observe(viewport);
      resize?.observe(track);
      for (const row of viewport.querySelectorAll('[data-message-viewport-boundary]')) resize?.observe(row);
      const column = viewport.querySelector('[data-thread-chat-reading-column]');
      if (column) resize?.observe(column);
    };
    const mutation = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === 'childList' &&
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches('[data-message-viewport-boundary]') ||
                  node.querySelector('[data-message-viewport-boundary]')),
            ),
        )
      )
        observeRows();
      scheduleLayout();
    });
    mutation.observe(viewport, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'style',
        'class',
        'aria-hidden',
        'data-deferred-message-id',
        'data-message-navigation-error',
        'data-message-navigation-response',
      ],
    });
    viewport.addEventListener('scroll', schedule, { passive: true });
    viewport.addEventListener('load', scheduleLayout, true);
    window.addEventListener('resize', scheduleLayout);
    observeRows();
    measure();
    return () => {
      active = false;
      if (frame !== null) cancelAnimationFrame(frame);
      mutation.disconnect();
      resize?.disconnect();
      viewport.removeEventListener('scroll', schedule);
      viewport.removeEventListener('load', scheduleLayout, true);
      window.removeEventListener('resize', scheduleLayout);
    };
  }, [messageIds, observerKey, trackRef, viewportRef]);
  return measurement && measurement.ownerKey === observerKey && measurement.ids === messageIds
    ? measurement.geometry
    : null;
}
