import { apiFetch } from '@/utils/api-client';
import { waitForPromiseWithSignal } from '@/utils/bounded-fetch';

const REVOKE_WAIT_MS = 400;

/** Give private sharing a short chance to revoke without holding F195 capture controls hostage. */
export async function revokeMeetingShareBeforeCapture(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REVOKE_WAIT_MS);
  try {
    await waitForPromiseWithSignal(
      apiFetch('/api/concierge/meeting-share', { method: 'DELETE', signal: controller.signal }),
      controller.signal,
    );
  } catch {
    // Capture stop/pause remains available if the optional sharing route stalls.
  } finally {
    clearTimeout(timeout);
  }
}
