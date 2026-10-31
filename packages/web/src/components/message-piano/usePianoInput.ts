import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ChatUserScrollGesture } from '@/hooks/useChatHistory';
import { wheelDeltaPx } from '../ClassicMessageNavigator';
import { type PianoGeometry, pianoKeyAtOffset } from './piano-geometry';

interface Drag {
  pointerId: number;
  startY: number;
  startScrollTop: number;
  gesture: ChatUserScrollGesture;
  ownerKey: string | undefined;
  begin: () => ChatUserScrollGesture | null;
}

function selectedKeyForCommand(key: string, selected: number, count: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, selected + 1);
    case 'ArrowUp':
      return Math.max(0, selected - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function usePianoInput(
  trackRef: RefObject<HTMLDivElement | null>,
  viewportRef: RefObject<HTMLElement | null>,
  geometry: PianoGeometry | null,
  beginUserScroll: () => ChatUserScrollGesture | null,
  onJumpToMessage: (id: string) => boolean,
  observerKey?: string,
) {
  const [selection, setSelection] = useState<{
    ownerKey: string | undefined;
    id: string | null;
    preview: boolean;
  }>({ ownerKey: undefined, id: null, preview: false });
  const activeId = selection.ownerKey === observerKey ? selection.id : null;
  const preview = selection.ownerKey === observerKey && selection.preview;
  const choose = (id: string | null, showPreview: boolean) =>
    setSelection({ ownerKey: observerKey, id, preview: showPreview });
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const candidate = geometry?.keys.findIndex((key) => key.id === activeId) ?? -1;
  const selected = geometry ? (candidate >= 0 ? candidate : pianoKeyAtOffset(geometry.keys, geometry.scrollTop)) : 0;
  const endDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    current?.gesture.end();
    const track = trackRef.current;
    if (current && track?.hasPointerCapture?.(current.pointerId)) track.releasePointerCapture(current.pointerId);
  }, [trackRef]);
  useEffect(() => {
    if (drag.current && (drag.current.ownerKey !== observerKey || drag.current.begin !== beginUserScroll)) endDrag();
    return () => endDrag();
  }, [beginUserScroll, endDrag, observerKey]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || !geometry) return;
    const wheel = (event: WheelEvent) => {
      const viewport = viewportRef.current;
      if (!viewport || event.ctrlKey || event.deltaY === 0) return;
      const gesture = beginUserScroll();
      if (!gesture) return;
      if (gesture.scrollTo(viewport.scrollTop + wheelDeltaPx(event, viewport))) event.preventDefault();
      gesture.end();
    };
    track.addEventListener('wheel', wheel, { passive: false });
    return () => track.removeEventListener('wheel', wheel);
  }, [beginUserScroll, geometry, trackRef, viewportRef]);

  const keyAtPointer = (clientY: number) => {
    if (!geometry || !trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const offset = ((clientY - rect.top) / rect.height) * geometry.contentHeight;
    return pianoKeyAtOffset(geometry.keys, offset);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (!geometry || !(event.target as Element).closest('[data-message-piano-thumb], [data-message-piano-grab]'))
      return;
    const gesture = beginUserScroll();
    if (!gesture) return;
    endDrag();
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: viewportRef.current?.scrollTop ?? geometry.scrollTop,
      gesture,
      ownerKey: observerKey,
      begin: beginUserScroll,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!geometry) return;
    const current = drag.current;
    if (current) {
      if (event.pointerId !== current.pointerId) return;
      const top =
        current.startScrollTop + ((event.clientY - current.startY) / geometry.trackHeight) * geometry.contentHeight;
      if (!current.gesture.scrollTo(top)) endDrag();
      event.preventDefault();
      return;
    }
    choose(geometry.keys[keyAtPointer(event.clientY)].id, true);
  };
  const onPointerUp = () => {
    if (drag.current) suppressClick.current = true;
    endDrag();
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!geometry) return;
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const target = (event.target as Element).closest<HTMLElement>('[data-message-piano-key]');
    const targeted = geometry.keys.findIndex((key) => key.id === target?.dataset.messagePianoKey);
    const index = targeted >= 0 ? targeted : keyAtPointer(event.clientY);
    choose(geometry.keys[index].id, preview);
    onJumpToMessage(geometry.keys[index].id);
  };
  const scrollPage = (key: string, keys: PianoGeometry['keys']) => {
    const viewport = viewportRef.current;
    const gesture = beginUserScroll();
    let next = selected;
    if (viewport && gesture) {
      const goal = viewport.scrollTop + (key === 'PageUp' ? -1 : 1) * viewport.clientHeight;
      if (gesture.scrollTo(goal)) next = pianoKeyAtOffset(keys, Math.max(0, goal));
    }
    gesture?.end();
    return next;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!geometry) return;
    const keys = geometry.keys;
    const selectedCommand = selectedKeyForCommand(event.key, selected, keys.length);
    if (selectedCommand !== null) {
      event.preventDefault();
      choose(keys[selectedCommand].id, true);
      return;
    }
    let next = selected;
    switch (event.key) {
      case 'PageUp':
      case 'PageDown': {
        next = scrollPage(event.key, keys);
        break;
      }
      case 'Enter':
        onJumpToMessage(keys[selected].id);
        break;
      case 'Escape':
        viewportRef.current?.focus({ preventScroll: true });
        break;
      default:
        return;
    }
    event.preventDefault();
    choose(keys[next].id, event.key !== 'Escape');
  };
  return {
    selected,
    preview,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
      onClick,
      onKeyDown,
      onPointerLeave: () => choose(activeId, false),
      onFocus: () => {
        if (geometry) choose(geometry.keys[pianoKeyAtOffset(geometry.keys, geometry.scrollTop)].id, true);
      },
      onBlur: () => choose(activeId, false),
    },
  };
}
