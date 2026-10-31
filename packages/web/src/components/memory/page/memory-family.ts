export type MemoryFamily = 'taste' | 'people' | 'profile' | 'entities' | 'events';
export const MEMORY_FAMILIES: { id: MemoryFamily; label: string; sky: string }[] = [
  { id: 'taste', label: '品味', sky: 'taste' },
  { id: 'profile', label: '画像', sky: 'profile' },
  { id: 'people', label: '人物', sky: 'person' },
  { id: 'entities', label: '实体', sky: 'entity' },
  { id: 'events', label: '事件', sky: 'event' },
];
