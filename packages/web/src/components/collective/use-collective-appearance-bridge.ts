'use client';

import { type RefObject, useCallback, useEffect, useRef } from 'react';

import { useShellPresentation } from '../shell/shell-presentation';
import {
  createAppearanceSequencer,
  type ResolveHostColor,
  readHostAppearance,
  resolveColorFromDocument,
} from './collective-appearance-producer';
import type { ObservedFrameGeneration } from './use-collective-world-directory';

/**
 * F322 B — host appearance bridge v1, host side. Says the Café's look to the shared room's frame: the interface version
 * (`useShellPresentation`, the one switch), the resolved scheme (`data-theme` on <html>, what next-themes resolved) and the
 * closed set of resolved colours (read from the page's own F056 tokens). It speaks only to the frame generation the
 * world-directory handshake minted, only to that Service origin, and only when the look changed.
 *
 * The triggers are the things that change the page's resolved tokens, not their producers: attribute changes on <html>
 * (scheme, shell marker) and changes under <head> (the theme and co-creator styles that ThemeApplier, CatHueInjector and
 * CoCreatorHueInjector inject). So a saved or tuned theme and a changed co-creator colour arrive the same way, with no
 * second path to a store and no reload.
 */
export function useCollectiveAppearanceBridge(input: {
  readonly iframeRef: RefObject<HTMLIFrameElement | null>;
  readonly frameGeneration: ObservedFrameGeneration | undefined;
  /** Tests only: the default reads the page with the browser's own colour engine. */
  readonly resolveColor?: ResolveHostColor;
}) {
  const presentation = useShellPresentation();
  const sequencer = useRef(createAppearanceSequencer());
  const defaultResolver = useRef<ResolveHostColor>();
  const latest = useRef({ ...input, presentation });
  latest.current = { ...input, presentation };

  const publish = useCallback(() => {
    const { frameGeneration, iframeRef, presentation: current, resolveColor } = latest.current;
    const frame = iframeRef.current?.contentWindow;
    if (!frameGeneration || !frame) return;
    defaultResolver.current ??= resolveColorFromDocument();
    const appearance = readHostAppearance({
      presentation: current,
      scheme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
      resolveColor: resolveColor ?? defaultResolver.current,
    });
    if (!appearance) return;
    const message = sequencer.current.next(frameGeneration.bridgeId, appearance);
    if (message) frame.postMessage(message, frameGeneration.serviceOrigin);
  }, []);

  const bridgeId = input.frameGeneration?.bridgeId;
  const serviceOrigin = input.frameGeneration?.serviceOrigin;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new generation or interface version is the trigger.
  useEffect(() => {
    publish();
  }, [bridgeId, serviceOrigin, presentation, publish]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: observe while a generation exists; a new one needs no new observer.
  useEffect(() => {
    if (!bridgeId) return;
    const observer = new MutationObserver(publish);
    observer.observe(document.documentElement, { attributes: true });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [Boolean(bridgeId), publish]);
}
