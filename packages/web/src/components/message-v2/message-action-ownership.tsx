'use client';

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react';

type Kind = 'message' | 'anchor';
interface Reset {
  kind: Kind;
  callback(): void;
  pending: boolean;
}
export interface MessageActionOwnership {
  id: string;
  pending(readMessage: () => boolean): void;
  settle(message: boolean, anchor: boolean): void;
  available(kind: Kind): boolean;
  register(node: HTMLElement, kind: Kind): () => void;
  subscribe(reset: Reset): () => void;
}
const Owner = createContext<MessageActionOwnership | null>(null);
const Scope = createContext<Kind>('message');
export const MessageActionOwnershipProvider = Owner.Provider;
export const MessageActionScope = Scope.Provider;

function createOwnership(id: string): MessageActionOwnership {
  let pending = true;
  const available = { message: false, anchor: false };
  const roots = new Map<HTMLElement, { kind: Kind; inert: boolean; aria: string | null }>();
  const resets = new Set<Reset>();
  const canUse = (kind: Kind) => available[kind] && (kind === 'message' || !pending);
  const apply = (node: HTMLElement, source: { kind: Kind; inert: boolean; aria: string | null }) => {
    const allowed = canUse(source.kind);
    node.toggleAttribute('data-message-action-unavailable', !allowed);
    node.toggleAttribute('inert', !allowed || source.inert);
    if (!allowed) node.setAttribute('aria-hidden', 'true');
    else if (source.aria === null) node.removeAttribute('aria-hidden');
    else node.setAttribute('aria-hidden', source.aria);
    node.dataset.messageActionState =
      pending && source.kind === 'anchor' ? 'pending' : allowed ? 'available' : 'unavailable';
    const active = document.activeElement;
    if (!allowed && active instanceof HTMLElement && node.contains(active)) active.blur();
  };
  return {
    id,
    available: canUse,
    pending(readMessage) {
      // Most rows have no body portal. Only an active selection/dialog needs an
      // immediate visibility check; toolbar-only rows retain the batched layout pass.
      const hasMessageSurface = [...roots.values()].some((source) => source.kind === 'message');
      const messageReadable = hasMessageSurface && readMessage();
      const messageLost = hasMessageSurface && available.message && !messageReadable;
      pending = true;
      // Toolbar placement is pending; the independently checked body may still be readable.
      available.message = messageReadable;
      for (const [node, source] of roots) apply(node, source);
      for (const reset of resets) if (reset.pending || (messageLost && reset.kind === 'message')) reset.callback();
    },
    settle(message, anchor) {
      const lost = { message: available.message && !message, anchor: available.anchor && !anchor };
      pending = false;
      available.message = message;
      available.anchor = anchor;
      for (const [node, source] of roots) apply(node, source);
      for (const reset of resets) if (lost[reset.kind]) reset.callback();
    },
    register(node, kind) {
      const source = { kind, inert: node.hasAttribute('inert'), aria: node.getAttribute('aria-hidden') };
      roots.set(node, source);
      node.dataset.messageActionOwned = id;
      node.dataset.messageActionSource = kind;
      apply(node, source);
      if (!pending && !available[kind]) for (const reset of resets) if (reset.kind === kind) reset.callback();
      return () => {
        roots.delete(node);
        node.removeAttribute('data-message-action-unavailable');
        delete node.dataset.messageActionOwned;
        delete node.dataset.messageActionSource;
        delete node.dataset.messageActionState;
        node.toggleAttribute('inert', source.inert);
        if (source.aria === null) node.removeAttribute('aria-hidden');
        else node.setAttribute('aria-hidden', source.aria);
      };
    },
    subscribe(reset) {
      resets.add(reset);
      if (!pending && !available[reset.kind]) reset.callback();
      return () => {
        resets.delete(reset);
      };
    },
  };
}

/** One message owner; readable body and author-anchor placement are distinct capabilities. */
export function useMessageActionOwnership(id: string) {
  return useMemo(() => createOwnership(id), [id]);
}

export function useActionOwnerReset(
  callback: () => void,
  override?: MessageActionOwnership | null,
  kindOverride?: Kind,
  pending = false,
) {
  const inherited = useContext(Owner),
    scope = useContext(Scope);
  const owner = override === undefined ? inherited : override;
  const kind = kindOverride ?? scope;
  const latest = useRef(callback);
  latest.current = callback;
  useLayoutEffect(() => owner?.subscribe({ kind, pending, callback: () => latest.current() }), [owner, kind, pending]);
}

export function useActionSurfaceRef<T extends HTMLElement>(
  override?: MessageActionOwnership | null,
  kindOverride?: Kind,
  forward?: { current: T | null },
) {
  const inherited = useContext(Owner),
    scope = useContext(Scope);
  const owner = override === undefined ? inherited : override;
  const kind = kindOverride ?? scope;
  const release = useRef<(() => void) | null>(null);
  return useCallback(
    (node: T | null) => {
      release.current?.();
      if (forward) forward.current = node;
      release.current = node && owner ? owner.register(node, kind) : null;
    },
    [owner, kind, forward],
  );
}
