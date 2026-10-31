import type { ReactNode } from 'react';
import { MemoryEntities } from './MemoryEntities';
import { MemoryEvents } from './MemoryEvents';
import { MemoryPeople } from './MemoryPeople';
import { MemoryProfile } from './MemoryProfile';
import type { MemoryFamily } from './memory-family';

export function MemoryFamilyPane({
  family,
  children,
  summaries,
}: {
  family: MemoryFamily;
  children: ReactNode;
  summaries: Record<Exclude<MemoryFamily, 'taste'>, (value: string) => void>;
}) {
  switch (family) {
    case 'people':
      return <MemoryPeople onReadSummary={summaries.people} />;
    case 'profile':
      return <MemoryProfile onReadSummary={summaries.profile} />;
    case 'entities':
      return <MemoryEntities onReadSummary={summaries.entities} />;
    case 'events':
      return <MemoryEvents onReadSummary={summaries.events} />;
    default:
      return <>{children}</>;
  }
}
