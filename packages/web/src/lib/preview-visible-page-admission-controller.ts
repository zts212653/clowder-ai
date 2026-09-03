import type { PreviewVisiblePageAdmission, PreviewVisiblePageAttestation } from '@cat-cafe/shared';

export interface PreviewVisiblePageAdmissionRequest {
  eventId: string;
  port: number;
  path: string;
  targetOrigin: string;
  admission: PreviewVisiblePageAdmission;
}

export type PreviewVisiblePageAdmissionFailureReason =
  | 'visible_page_timeout'
  | 'visible_page_superseded'
  | 'visible_page_unavailable'
  | 'visible_page_load_error'
  | 'visible_page_contract_invalid';

export type PreviewVisiblePageAdmissionResolution =
  | { status: 'attested'; attestation: PreviewVisiblePageAttestation }
  | { status: 'failed'; reason: PreviewVisiblePageAdmissionFailureReason };

interface PendingAdmission {
  request: PreviewVisiblePageAdmissionRequest;
  resolve: (resolution: PreviewVisiblePageAdmissionResolution) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PreviewVisiblePageAdmissionController {
  begin: (request: PreviewVisiblePageAdmissionRequest) => Promise<PreviewVisiblePageAdmissionResolution>;
  attest: (attestation: PreviewVisiblePageAttestation) => void;
  fail: (eventId: string, reason: PreviewVisiblePageAdmissionFailureReason) => void;
  getSnapshot: () => PreviewVisiblePageAdmissionRequest | null;
  subscribe: (listener: () => void) => () => void;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export function createPreviewVisiblePageAdmissionController(
  options: { timeoutMs?: number } = {},
): PreviewVisiblePageAdmissionController {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const listeners = new Set<() => void>();
  let current: PendingAdmission | null = null;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const settle = (pending: PendingAdmission, resolution: PreviewVisiblePageAdmissionResolution) => {
    clearTimeout(pending.timeout);
    if (current === pending) {
      current = null;
      notify();
    }
    pending.resolve(resolution);
  };

  return {
    begin(request) {
      if (current) settle(current, { status: 'failed', reason: 'visible_page_superseded' });
      return new Promise<PreviewVisiblePageAdmissionResolution>((resolve) => {
        const pending = {
          request,
          resolve,
          timeout: setTimeout(() => settle(pending, { status: 'failed', reason: 'visible_page_timeout' }), timeoutMs),
        };
        current = pending;
        notify();
      });
    },
    attest(attestation) {
      if (!current || current.request.eventId !== attestation.eventId) return;
      settle(current, { status: 'attested', attestation });
    },
    fail(eventId, reason) {
      if (!current || current.request.eventId !== eventId) return;
      settle(current, { status: 'failed', reason });
    },
    getSnapshot: () => current?.request ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const previewVisiblePageAdmissionController = createPreviewVisiblePageAdmissionController();
