'use client';

import { create } from 'zustand';
import { apiFetch } from '@/utils/api-client';

interface DesktopObservation {
  visible: boolean;
  available: boolean;
  desktopLost: boolean;
  lossId: string | null;
  noticeVisible: boolean;
}

const DISMISSED_LOSS_KEY = 'cat-cafe:concierge:desktop-loss-dismissed-v1';
const emptyObservation = (): DesktopObservation => ({
  visible: false,
  available: false,
  desktopLost: false,
  lossId: null,
  noticeVisible: false,
});

/** Ephemeral presence; only the acknowledgement of one durable Host failure survives a page reload. */
export const useConciergeDesktopStore = create<DesktopObservation>(() => emptyObservation());
let dismissedLossIdInMemory: string | null = null;
let generation = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;
let pending: Promise<boolean> | undefined;
let controller: AbortController | undefined;
let showing: Promise<boolean> | undefined;

function storedDismissedLossId(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISSED_LOSS_KEY);
  } catch {
    return null;
  }
}

function storeDismissedLossId(lossId: string): void {
  try {
    window.sessionStorage.setItem(DISMISSED_LOSS_KEY, lossId);
  } catch {
    // The in-memory acknowledgement still covers polling when storage is unavailable.
  }
}

function clearDismissedLossId(lossId: string): void {
  try {
    if (window.sessionStorage.getItem(DISMISSED_LOSS_KEY) === lossId)
      window.sessionStorage.removeItem(DISMISSED_LOSS_KEY);
  } catch {
    // A user-triggered view still works for this mounted page.
  }
}

export function dismissConciergeDesktopLossNotice(): void {
  const { desktopLost, lossId } = useConciergeDesktopStore.getState();
  if (!desktopLost) return;
  if (lossId) {
    dismissedLossIdInMemory = lossId;
    storeDismissedLossId(lossId);
  }
  useConciergeDesktopStore.setState({ noticeVisible: false });
}

export function reopenConciergeDesktopLossNotice(): void {
  const { desktopLost, lossId } = useConciergeDesktopStore.getState();
  if (!desktopLost) return;
  if (lossId) {
    if (dismissedLossIdInMemory === lossId) dismissedLossIdInMemory = null;
    clearDismissedLossId(lossId);
  }
  useConciergeDesktopStore.setState({ noticeVisible: true });
}

function responseLossId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('lossId' in value)) return null;
  const lossId = value.lossId;
  return typeof lossId === 'string' && lossId.length > 0 && lossId.length <= 128 ? lossId : null;
}

function publishMissingPresence(value: unknown): false {
  const reportedLoss = value && typeof value === 'object' && 'desktopLost' in value ? value.desktopLost : undefined;
  if (reportedLoss === true) {
    const lossId = responseLossId(value);
    const previous = useConciergeDesktopStore.getState();
    const dismissed = lossId
      ? dismissedLossIdInMemory === lossId || storedDismissedLossId() === lossId
      : previous.desktopLost && previous.lossId === null && !previous.noticeVisible;
    useConciergeDesktopStore.setState({
      visible: false,
      available: false,
      desktopLost: true,
      lossId,
      noticeVisible: !dismissed,
    });
  } else if (reportedLoss === false) {
    useConciergeDesktopStore.setState(emptyObservation());
  } else {
    // A failed or malformed read cannot revoke a previously observed Host failure.
    useConciergeDesktopStore.setState({ visible: false, available: false });
  }
  return false;
}

function publish(value: unknown, elapsed: number): boolean {
  clearTimeout(expiry);
  const presence = value && typeof value === 'object' && 'presence' in value ? value.presence : null;
  if (
    !presence ||
    typeof presence !== 'object' ||
    !('state' in presence) ||
    !['visible', 'hidden'].includes(String(presence.state)) ||
    !('maxAgeMs' in presence) ||
    typeof presence.maxAgeMs !== 'number' ||
    !Number.isFinite(presence.maxAgeMs)
  )
    return publishMissingPresence(value);
  const remaining = Math.min(15_000, presence.maxAgeMs) - elapsed;
  if (remaining <= 0) {
    useConciergeDesktopStore.setState({ visible: false, available: false });
    return false;
  }
  useConciergeDesktopStore.setState({
    visible: presence.state === 'visible',
    available: true,
    desktopLost: false,
    lossId: null,
    noticeVisible: false,
  });
  expiry = setTimeout(() => {
    useConciergeDesktopStore.setState({ visible: false, available: false });
  }, remaining);
  return true;
}

export function resetConciergeDesktopObservation(): void {
  ++generation;
  controller?.abort();
  controller = undefined;
  pending = undefined;
  clearTimeout(expiry);
  dismissedLossIdInMemory = null;
  useConciergeDesktopStore.setState(emptyObservation());
}

export function refreshConciergeDesktop(): Promise<boolean> {
  if (pending) return pending;
  const current = generation;
  const started = performance.now();
  const request = new AbortController();
  controller = request;
  const timeout = setTimeout(() => request.abort(), 2000);
  const operation = (async () => {
    try {
      const response = await apiFetch('/api/concierge/desktop', { signal: request.signal });
      const data: unknown = response.ok ? await response.json() : null;
      return current === generation ? publish(data, performance.now() - started) : false;
    } catch {
      if (current === generation) publish(null, 0);
      return false;
    } finally {
      clearTimeout(timeout);
      if (controller === request) controller = undefined;
    }
  })();
  pending = operation;
  void operation.finally(() => {
    if (pending === operation) pending = undefined;
  });
  return operation;
}

export function showConciergeDesktop(): Promise<boolean> {
  if (showing) return showing;
  // An earlier GET cannot overwrite this explicit operation's later observation.
  const current = ++generation;
  controller?.abort();
  pending = undefined;
  const started = performance.now();
  const operation = (async () => {
    try {
      const response = await apiFetch('/api/concierge/desktop/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) return false;
      const data: unknown = await response.json();
      const presence = data && typeof data === 'object' && 'presence' in data ? data.presence : null;
      const elapsed = performance.now() - started;
      if (
        !presence ||
        typeof presence !== 'object' ||
        !('state' in presence) ||
        presence.state !== 'visible' ||
        !('maxAgeMs' in presence) ||
        typeof presence.maxAgeMs !== 'number' ||
        !Number.isFinite(presence.maxAgeMs) ||
        Math.min(15_000, presence.maxAgeMs) <= elapsed
      )
        return false;
      return current === generation ? publish(data, elapsed) : false;
    } catch {
      return false;
    }
  })();
  showing = operation;
  void operation.finally(() => {
    if (showing === operation) showing = undefined;
  });
  return operation;
}

export function watchConciergeDesktop(): () => void {
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    await refreshConciergeDesktop();
    if (!ended) timer = setTimeout(() => void tick(), 3000);
  };
  const focus = () => {
    if (!ended) void refreshConciergeDesktop();
  };
  void tick();
  window.addEventListener('focus', focus);
  return () => {
    ended = true;
    clearTimeout(timer);
    window.removeEventListener('focus', focus);
    resetConciergeDesktopObservation();
  };
}
