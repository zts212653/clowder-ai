'use client';

import { useMemo } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { actualColoursOf } from '@/lib/actual-colours';
import { humanColorState } from '@/lib/human-color';
import type { ActualColours } from '@/lib/readable-name-plate';

/**
 * The colours that are really in the room (lib/actual-colours): the catalogue the injector paints, and the human as the shell
 * on screen paints them. Stable between renders while nothing changed, so an effect that resolves the theme against it runs
 * again only when a cat, a colour, the shell or the human colour really changes. `undefined` until the catalogue request has answered (an empty answer counts).
 */
export function useActualColours(): ActualColours | undefined {
  const { cats, hasFetched } = useCatData();
  const shell = useShellPresentation();
  const human = humanColorState(useCoCreatorConfig());
  const humanPrimary = human.status === 'configured' ? human.color.primary : null;
  // The catalogue array is a new object on every refresh: key on what it paints.
  const key = JSON.stringify([
    cats.map((cat) => [cat.id, cat.color?.primary ?? null]),
    hasFetched,
    shell,
    humanPrimary,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the content of `cats`, `hasFetched`, `shell` and `humanPrimary`
  return useMemo(() => actualColoursOf({ cats, loaded: hasFetched, shell, humanPrimary }), [key]);
}
