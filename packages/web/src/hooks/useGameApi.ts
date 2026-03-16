import type { GameView, SeatId } from '@cat-cafe/shared';
import { API_URL } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': getUserId(),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchGameState(threadId: string, viewer?: string): Promise<GameView | null> {
  try {
    const params = viewer ? `?viewer=${viewer}` : '';
    return await apiFetch<GameView>(`/api/threads/${threadId}/game${params}`);
  } catch {
    return null;
  }
}

export async function submitAction(
  threadId: string,
  seatId: SeatId,
  actionName: string,
  targetSeat?: SeatId,
  params?: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  try {
    await apiFetch(`/api/threads/${threadId}/game/action`, {
      method: 'POST',
      body: JSON.stringify({ seatId, actionName, targetSeat, params }),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function godAction(threadId: string, action: string): Promise<{ success: boolean; error?: string }> {
  try {
    await apiFetch(`/api/threads/${threadId}/game/god-action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function abortGame(threadId: string): Promise<void> {
  await apiFetch(`/api/threads/${threadId}/game`, { method: 'DELETE' });
}
