import type { Redis } from 'ioredis';

export interface EvalCatOverride {
  catId: string;
  handle: string;
  model: string;
  setAt: string;
}

function overrideKey(domainId: string): string {
  return `eval-domain:${domainId}:evalCat-override`;
}

export async function getEvalCatOverride(redis: Redis, domainId: string): Promise<EvalCatOverride | null> {
  const raw = await redis.get(overrideKey(domainId));
  if (!raw) return null;
  return JSON.parse(raw) as EvalCatOverride;
}

export async function setEvalCatOverride(
  redis: Redis,
  domainId: string,
  override: Omit<EvalCatOverride, 'setAt'>,
): Promise<EvalCatOverride> {
  const entry: EvalCatOverride = { ...override, setAt: new Date().toISOString() };
  await redis.set(overrideKey(domainId), JSON.stringify(entry));
  return entry;
}

export async function clearEvalCatOverride(redis: Redis, domainId: string): Promise<void> {
  await redis.del(overrideKey(domainId));
}
