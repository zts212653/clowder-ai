import { apiFetch } from '@/utils/api-client';
import { executeSidebarFieldCommand } from '@/utils/sidebar-commands';

async function save(threadId: string, field: 'preferredCats' | 'labels', value: string[]) {
  const ok = await executeSidebarFieldCommand({
    threadId,
    field,
    value,
    request: (signal) =>
      apiFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
        signal,
      }),
  });
  if (!ok) throw new Error('保存失败');
}

export const saveThreadPreferredCats = (threadId: string, cats: string[]) => save(threadId, 'preferredCats', cats);
export const saveThreadLabels = (threadId: string, labels: string[]) => save(threadId, 'labels', labels);
