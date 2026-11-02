import { getCachedCats } from '@/hooks/useCatData';
export const canonStatusLabel = { canonical: '正典', experimental: '实验', failed: '失败样本' };
export const canonActor = (actor: { kind: string; actorId: string }) =>
  actor.kind === 'human' ? '你' : (getCachedCats().find((cat) => cat.id === actor.actorId)?.nickname ?? actor.actorId);
