import type { CatData } from '../../../src/hooks/useCatData';

const cats = [
  {
    id: 'codex',
    displayName: '小太阳',
    nickname: '小太阳',
    name: 'Sol',
    mentionPatterns: ['codex'],
    carrier: 'cli',
    clientId: 'openai',
    provider: 'openai',
    cli: { command: 'codex' },
    defaultModel: 'gpt-6.1-sol',
  },
] as CatData[];
export const getCachedCats = () => cats;
export const useCatData = () => ({ cats, getCatById: (id: string) => cats.find((c) => c.id === id) });
export const formatCatName = (cat: CatData) => cat.nickname ?? cat.displayName;
