import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';

export interface InteractiveSendDetail {
  text?: string;
  sendContext?: string;
  targetThreadId?: string;
  onResult?: (sent: boolean) => void;
}

/** The owning chat surface acknowledges admission; dispatch alone is not a send receipt. */
export function dispatchInteractiveSend(text: string, sendContext?: string): Promise<boolean> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<InteractiveSendDetail>('cat-cafe:interactive-send', {
        detail: { text, sendContext, onResult: resolve },
      }),
    );
  });
}

export async function patchBlockState(
  messageId: string,
  blockId: string,
  patch: { disabled?: boolean; selectedIds?: string[] },
): Promise<void> {
  // Retry only a transient save, never the accepted answer or a rejected 4xx request.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await apiFetch(`/api/messages/${messageId}/block-state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: getUserId(), blockId, ...patch }),
    }).catch(() => null);
    if (response?.ok) return;
    if (response && response.status < 500) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  useToastStore.getState().addToast({
    type: 'error',
    title: '选择状态保存失败',
    message: '操作已提交，但选择状态未能保存。请勿重复提交。',
    duration: 8000,
  });
}
