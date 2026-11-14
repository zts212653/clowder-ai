'use client';

import type { PluginMentionTarget } from '@cat-cafe/shared';
import { useSyncExternalStore } from 'react';
import { apiFetch } from '@/utils/api-client';

type Projection = { targets: PluginMentionTarget[]; knownTargets: PluginMentionTarget[] };
const empty: Projection = { targets: [], knownTargets: [] };
let snapshot = empty;
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();

export function refreshPluginMentionTargets(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    let next = empty;
    try {
      const response = await apiFetch('/api/plugin-manager/addressed-targets');
      if (response.ok) {
        const data = await response.json();
        next = { targets: data.targets ?? [], knownTargets: data.knownTargets ?? data.targets ?? [] };
      }
    } catch {
      /* Failed discovery must not offer a stale delivery target. */
    }
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
      snapshot = next;
      listeners.forEach((notify) => notify());
      window.dispatchEvent(new Event('plugin-addresses-refreshed'));
    }
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) {
    void refreshPluginMentionTargets();
    window.addEventListener('focus', refreshPluginMentionTargets);
    window.addEventListener('plugin-targets-changed', refreshPluginMentionTargets);
  }
  return () => {
    listeners.delete(notify);
    if (!listeners.size) {
      window.removeEventListener('focus', refreshPluginMentionTargets);
      window.removeEventListener('plugin-targets-changed', refreshPluginMentionTargets);
    }
  };
}
/** Shared inventory projection for composer, receipts and queue; never CatData. */
export function usePluginTargets() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => empty,
  );
}
export function usePluginMentionTargets() {
  return usePluginTargets().targets;
}
