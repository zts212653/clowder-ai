import { apiFetch } from '@/utils/api-client';

/** Only call for a verified empty initial roster, before its first member write. */
export async function prepareFirstRunEntry(): Promise<void> {
  const response = await apiFetch('/api/config/onboarding/entry', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'pending' }),
  });
  if (!response.ok) throw Error('入口提醒暂时无法登记，请重试；填写内容已保留，尚未创建新伙伴。');
  const receipt = (await response.json()) as { status?: unknown };
  if (!['pending', 'dismissed', 'completed'].includes(String(receipt.status)))
    throw Error('入口提醒记录尚未确认，请重试；填写内容已保留。');
}
