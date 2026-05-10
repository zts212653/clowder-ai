import type { BacklogItem, ThreadPhase } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

export async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `Request failed: ${response.status}`;
  } catch {
    return `Request failed: ${response.status}`;
  }
}

type SelfClaimPolicyBlocker = 'once' | 'thread' | null;

export function detectBlocker(raw: string): SelfClaimPolicyBlocker {
  if (raw.includes('Self-claim once policy already consumed')) return 'once';
  if (raw.includes('Self-claim thread policy blocked')) return 'thread';
  return null;
}

export function formatError(raw: string): string {
  const b = detectBlocker(raw);
  if (b === 'once') return 'Self-claim 被 once 策略阻断：该猫的自领额度已用完。';
  if (b === 'thread') return 'Self-claim 被 thread 策略阻断：该猫已有 active lease 线程，请先释放或回收。';
  return raw;
}

async function postBacklog(path: string, body?: object): Promise<void> {
  const opts: RequestInit = { method: 'POST' };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await apiFetch(path, opts);
  if (!res.ok) throw new Error(await parseError(res));
}

function itemPath(itemId: string, suffix: string): string {
  return `/api/backlog/items/${encodeURIComponent(itemId)}/${suffix}`;
}

export async function createBacklogItem(payload: {
  title: string;
  summary: string;
  priority: BacklogItem['priority'];
  tags: string[];
}): Promise<BacklogItem> {
  const res = await apiFetch('/api/backlog/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as BacklogItem;
}

export async function suggestClaim(payload: {
  itemId: string;
  catId: string;
  why: string;
  plan: string;
  requestedPhase: ThreadPhase;
}): Promise<void> {
  await postBacklog(itemPath(payload.itemId, 'suggest-claim'), {
    catId: payload.catId,
    why: payload.why,
    plan: payload.plan,
    requestedPhase: payload.requestedPhase,
  });
}

export async function decideClaim(
  itemId: string,
  decision: 'approve' | 'reject',
  extra?: { threadPhase?: ThreadPhase; note?: string },
): Promise<void> {
  await postBacklog(itemPath(itemId, 'decide-claim'), { decision, ...extra });
}

export async function selfClaim(payload: {
  itemId: string;
  catId: string;
  why: string;
  plan: string;
  requestedPhase: ThreadPhase;
}): Promise<void> {
  await postBacklog(itemPath(payload.itemId, 'self-claim'), {
    catId: payload.catId,
    why: payload.why,
    plan: payload.plan,
    requestedPhase: payload.requestedPhase,
  });
}

export async function acquireLease(payload: { itemId: string; catId: string; ttlMs?: number }): Promise<void> {
  await postBacklog(itemPath(payload.itemId, 'lease/acquire'), {
    catId: payload.catId,
    ...(payload.ttlMs ? { ttlMs: payload.ttlMs } : {}),
  });
}

export async function heartbeatLease(payload: { itemId: string; catId: string; ttlMs?: number }): Promise<void> {
  await postBacklog(itemPath(payload.itemId, 'lease/heartbeat'), {
    catId: payload.catId,
    ...(payload.ttlMs ? { ttlMs: payload.ttlMs } : {}),
  });
}

export async function releaseLease(payload: { itemId: string; catId?: string }): Promise<void> {
  await postBacklog(itemPath(payload.itemId, 'lease/release'), payload.catId ? { catId: payload.catId } : {});
}

export async function reclaimLease(payload: { itemId: string }): Promise<void> {
  await postBacklog(itemPath(payload.itemId, 'lease/reclaim'));
}

export async function deleteItem(itemId: string): Promise<void> {
  const res = await apiFetch(`/api/backlog/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function importActiveFeatures(): Promise<void> {
  await postBacklog('/api/backlog/import-active-features');
}
