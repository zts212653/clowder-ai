/**
 * F322 original-B: the one request behind every "强制重置" button, and the one answer to "did it work?".
 *
 * The old execution bar used to ignore the response (a 409 PRESTART_STATE_CHANGED or a 503 still toasted
 * "已重置"; a dropped request escaped as an unhandled rejection). The one-row surface and the old bar now share
 * this, so a refusal can never be reported as success. Only the outcome is decided here: what the user sees
 * (dialog, toast) stays with each caller. The endpoint itself and its permissions are the server's (F220).
 */
import { apiFetch } from '@/utils/api-client';

export type ThreadForceResetResult = { ok: true } | { ok: false; message: string };

export async function postThreadForceReset(threadId: string): Promise<ThreadForceResetResult> {
  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/force-reset`, { method: 'POST' });
    if (response.ok) return { ok: true };
    const data = await response.json().catch(() => ({}));
    return { ok: false, message: data?.error ?? '运行状态仍未解除' };
  } catch {
    return { ok: false, message: '恢复请求没有完成' };
  }
}
