import { type ComponentProps, useCallback } from 'react';
import { useEvolutionReading } from '../evolution-reading-state';

/** Persist only exact reading coordinates, never a cached submission or decision. */
export function PreparationDetails({
  programId,
  readingKey,
  ...props
}: ComponentProps<'details'> & {
  programId: string;
  readingKey: string;
}) {
  const open = useEvolutionReading(
    (state) => state.programs[programId]?.preparationOpenDetails?.includes(readingKey) ?? false,
  );
  const onToggle = useCallback(
    (event: React.SyntheticEvent<HTMLDetailsElement>) => {
      const next = event.currentTarget.open;
      const store = useEvolutionReading.getState();
      const keys = store.programs[programId]?.preparationOpenDetails ?? [];
      if (keys.includes(readingKey) === next) return;
      store.update(programId, {
        preparationOpenDetails: next ? [...keys.slice(-127), readingKey] : keys.filter((key) => key !== readingKey),
      });
    },
    [programId, readingKey],
  );
  return <details {...props} open={open} onToggle={onToggle} />;
}
