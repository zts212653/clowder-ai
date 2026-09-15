import type { ExactAssetVersionRefV1 } from '@cat-cafe/shared';
import { useEffect } from 'react';
import { useEvolutionReading } from './evolution-reading-state';

/** Background owner hydration fills its own default; it is not a user navigation action. */
export function useEvolutionOwnerReadingDefault(programId: string, candidate?: ExactAssetVersionRefV1) {
  const selected = useEvolutionReading((state) => state.programs[programId]?.selectedVersionRef);
  useEffect(() => {
    const state = useEvolutionReading.getState();
    const current = state.programs[programId];
    if (current?.selectedVersionRef || !candidate) return;
    state.update(programId, { selectedVersionRef: candidate });
  }, [programId, candidate, selected]);
}
